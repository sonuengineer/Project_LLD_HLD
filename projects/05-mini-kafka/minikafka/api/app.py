"""HTTP front-end for the cluster (think: Kafka REST proxy). Values are UTF-8 strings."""
from __future__ import annotations

import hmac
import zlib
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field

from bpcommon.errors import Forbidden
from bpcommon.http import setup_app
from bpcommon.logging import configure_logging

from ..cluster.cluster import Cluster
from ..cluster.config import ClusterConfig
from ..cluster.errors import KafkaError

STATUS = {"unknown_topic_or_partition": 404, "topic_already_exists": 409, "invalid_replication_factor": 422,
          "out_of_order_sequence_number": 409, "offset_out_of_range": 409, "unknown_member_id": 409,
          "illegal_generation": 409}


class TopicCreate(BaseModel):
    name: str = Field(pattern=r"^[a-zA-Z0-9._\-]{1,100}$")
    partitions: int = Field(ge=1, le=256)
    replication_factor: int = Field(ge=1, le=10)
    min_insync_replicas: int = Field(default=1, ge=1)
    retention_ms: int | None = Field(default=None, ge=1)
    retention_bytes: int | None = Field(default=None, ge=1)


class RecordIn(BaseModel):
    key: str | None = None
    value: str


class ProduceIn(BaseModel):
    records: list[RecordIn] = Field(min_length=1, max_length=10_000)
    partition: int | None = None
    acks: str = Field(default="all", pattern=r"^(0|1|all|-1)$")
    producer_id: int | None = None
    base_sequence: int | None = None


class JoinIn(BaseModel):
    member_id: str | None = None
    topics: list[str] = Field(min_length=1)
    session_timeout_ms: int = Field(default=10_000, ge=100, le=300_000)
    strategy: str = Field(default="range", pattern=r"^(range|roundrobin)$")


class MemberIn(BaseModel):
    member_id: str
    generation: int = -1


class CommitOffset(BaseModel):
    topic: str
    partition: int
    offset: int = Field(ge=0)


class CommitIn(BaseModel):
    member_id: str | None = None
    generation: int = -1
    offsets: list[CommitOffset]


def _rec(r) -> dict:
    return {"offset": r.offset, "timestamp": r.timestamp, "key": r.key.decode() if r.key is not None else None,
            "value": r.value.decode("utf-8", "replace")}


def default_partition(key: str | None, n: int, counter: list[int]) -> int:
    """Same key -> same partition (per-key ordering). Kafka uses murmur2; crc32 is the stand-in.
    Changing the partition count changes the mapping -- that's why Kafka partitions are rarely added."""
    if key is None:
        counter[0] += 1
        return counter[0] % n
    return zlib.crc32(key.encode()) % n


def create_app(config: ClusterConfig, admin_token: str = "change-me-mk-token") -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.cluster = Cluster(config)
        await app.state.cluster.start()
        yield
        await app.state.cluster.stop()

    app = FastAPI(title="minikafka", version="1.0.0", lifespan=lifespan,
                  description="Partitioned, replicated commit log with consumer groups (in-process cluster).")
    setup_app(app, "minikafka")
    rr_counter = [0]

    @app.exception_handler(KafkaError)
    async def _kafka_error(_: Request, exc: KafkaError):
        status = STATUS.get(exc.code, 503 if exc.retriable else 400)
        return JSONResponse({"error": {"code": exc.code, "message": str(exc), "retriable": exc.retriable}},
                            status_code=status)

    def cl(request: Request) -> Cluster:
        return request.app.state.cluster

    async def admin(x_admin_token: str | None = Header(default=None)):
        if not x_admin_token or not hmac.compare_digest(x_admin_token, admin_token):
            raise Forbidden("admin token required")

    @app.post("/topics", status_code=201, tags=["topics"])
    async def create_topic(body: TopicCreate, request: Request):
        metas = cl(request).create_topic(body.name, body.partitions, body.replication_factor,
                                         min_insync_replicas=body.min_insync_replicas,
                                         retention_ms=body.retention_ms, retention_bytes=body.retention_bytes)
        return {"name": body.name, "partitions": len(metas)}

    @app.get("/metadata", tags=["topics"])
    async def metadata(request: Request):
        return cl(request).describe()

    @app.get("/topics/{topic}/partitions/{partition}/offsets", tags=["topics"])
    async def offsets(topic: str, partition: int, request: Request):
        return cl(request).offsets(topic, partition)

    @app.post("/producers", tags=["produce"])
    async def init_producer(request: Request):
        return {"producer_id": cl(request).init_producer_id()}

    @app.post("/topics/{topic}/produce", tags=["produce"])
    async def produce(topic: str, body: ProduceIn, request: Request):
        c = cl(request)
        c.meta(topic, 0)  # raises UnknownTopicOrPartition
        n = len(c.topics[topic])
        partition = body.partition if body.partition is not None else default_partition(body.records[0].key, n, rr_counter)
        res = await c.produce(topic, partition, [(r.key.encode() if r.key is not None else None, r.value.encode())
                                                 for r in body.records],
                              acks="all" if body.acks in ("all", "-1") else int(body.acks),
                              producer_id=body.producer_id, base_sequence=body.base_sequence)
        return {"topic": topic, "partition": partition, "base_offset": res.base_offset, "count": res.count,
                "duplicate": res.duplicate}

    @app.get("/topics/{topic}/partitions/{partition}/fetch", tags=["consume"])
    async def fetch(topic: str, partition: int, request: Request, offset: int = Query(ge=0),
                    max_bytes: int = Query(1024 * 1024, ge=1, le=16 * 1024 * 1024),
                    wait_ms: int = Query(0, ge=0, le=30_000)):
        recs, hw, start = await cl(request).fetch(topic, partition, offset, max_bytes=max_bytes, wait_ms=wait_ms)
        return {"records": [_rec(r) for r in recs], "high_watermark": hw, "log_start_offset": start}

    @app.post("/groups/{group}/join", tags=["groups"])
    async def join(group: str, body: JoinIn, request: Request):
        return await cl(request).groups.join(group, body.member_id, body.topics,
                                             session_timeout_ms=body.session_timeout_ms, strategy=body.strategy)

    @app.post("/groups/{group}/heartbeat", tags=["groups"])
    async def heartbeat(group: str, body: MemberIn, request: Request):
        cl(request).groups.heartbeat(group, body.member_id, body.generation)
        return {"ok": True}

    @app.post("/groups/{group}/leave", tags=["groups"])
    async def leave(group: str, body: MemberIn, request: Request):
        cl(request).groups.leave(group, body.member_id)
        return {"ok": True}

    @app.post("/groups/{group}/commit", tags=["groups"])
    async def commit(group: str, body: CommitIn, request: Request):
        cl(request).groups.commit(group, body.member_id, body.generation,
                                  {(o.topic, o.partition): o.offset for o in body.offsets})
        return {"ok": True}

    @app.get("/groups/{group}", tags=["groups"])
    async def describe_group(group: str, request: Request):
        c = cl(request)
        return {**c.groups.describe(group), "lag": c.group_lag(group)}

    @app.get("/groups", tags=["groups"])
    async def list_groups(request: Request):
        c = cl(request)
        return {"groups": [{**c.groups.describe(g), "lag": c.group_lag(g)} for g in c.groups.groups]}

    @app.get("/events", tags=["ops"])
    async def events(request: Request):
        return {"events": cl(request).events[-100:]}

    @app.post("/admin/brokers/{broker_id}/{action}", tags=["fault injection"], dependencies=[Depends(admin)])
    async def broker_action(broker_id: int, action: str, request: Request):
        c = cl(request)
        if action == "kill":
            await c.kill_broker(broker_id)
        elif action == "restart":
            await c.restart_broker(broker_id)
        elif action == "isolate":
            c.isolate_broker(broker_id, True)
        elif action == "heal":
            c.isolate_broker(broker_id, False)
        else:
            from bpcommon.errors import NotFound
            raise NotFound("action must be kill|restart|isolate|heal")
        return {"broker": broker_id, "action": action}

    html = (Path(__file__).parent / "dashboard.html").read_text(encoding="utf-8")

    @app.get("/dashboard", include_in_schema=False)
    async def dashboard():
        return HTMLResponse(html)

    return app


def app_from_env() -> FastAPI:
    import os
    configure_logging(os.getenv("MK_LOG_LEVEL", "INFO"), os.getenv("MK_LOG_JSON", "true") == "true")
    cfg = ClusterConfig(data_dir=Path(os.getenv("MK_DATA_DIR", "./data")), brokers=int(os.getenv("MK_BROKERS", "3")))
    return create_app(cfg, os.getenv("MK_ADMIN_TOKEN", "change-me-mk-token"))
