"""TCP server, command dispatch, propagation (AOF + replicas), and the periodic cron."""
from __future__ import annotations

import asyncio
import itertools
import logging
import os
import time
from dataclasses import dataclass, field

from .commands import REGISTRY, Context, check_arity
from .config import ServerConfig
from .keyspace import Keyspace
from .persistence import snapshot
from .persistence.aof import AppendOnlyFile
from .protocol import OK, Parser, ProtocolError, RespError, encode, encode_command
from .replication import ReplicaLink

log = logging.getLogger(__name__)
_ids = itertools.count(1)


@dataclass
class ClientState:
    addr: str
    writer: asyncio.StreamWriter
    id: int = field(default_factory=lambda: next(_ids))
    name: str = ""
    commands: int = 0
    is_replica: bool = False
    ack_offset: int = 0
    repl_base: int = 0  # master_repl_offset when this replica's full sync snapshot was taken
    proto: int = 2  # RESP version negotiated via HELLO


@dataclass
class PersistenceState:
    last_save_time: float = field(default_factory=time.time)
    dirty: int = 0                       # changes since last snapshot
    bgsave_in_progress: bool = False
    last_bgsave_ok: bool | None = None
    snapshots_written: int = 0
    loaded_from: str = "empty"


class Server:
    def __init__(self, config: ServerConfig):
        self.config = config
        self.ks = Keyspace()
        self.ks.on_implicit_delete = self._propagate
        self.clients: dict[int, ClientState] = {}
        self.replicas: dict[int, ClientState] = {}
        self.master_repl_offset = 0
        self.persistence = PersistenceState()
        self.aof: AppendOnlyFile | None = None
        self.replica_link: ReplicaLink | None = None
        self.started_at = time.time()
        self.total_commands = 0
        self.total_connections = 0
        self.rejected_replica_buffers = 0
        self._server: asyncio.base_events.Server | None = None
        self._tasks: list[asyncio.Task] = []
        self._bg: set[asyncio.Task] = set()
        self._repl_pending: list[bytes] = []
        self._repl_flush_scheduled = False

    # ---- lifecycle --------------------------------------------------------------------------
    @property
    def snapshot_path(self):
        return self.config.dir / self.config.dbfilename

    @property
    def aof_path(self):
        return self.config.dir / self.config.appendfilename

    @property
    def port(self) -> int:
        return self._server.sockets[0].getsockname()[1] if self._server else self.config.port

    async def start(self) -> None:
        self.config.dir.mkdir(parents=True, exist_ok=True)
        self._load_from_disk()
        if self.config.appendonly:
            self.aof = AppendOnlyFile(self.aof_path, self.config.appendfsync)
        if self.config.replicaof:
            self.become_replica_of(*self.config.replicaof)
        self._server = await asyncio.start_server(self._handle_client, self.config.host, self.config.port)
        self._tasks.append(asyncio.create_task(self._cron(), name="cron"))
        log.info("minidis_started", extra={"port": self.port, "loaded_from": self.persistence.loaded_from,
                                           "keys": len(self.ks)})

    def _load_from_disk(self) -> None:
        # AOF is preferred: it is usually more up to date than the last snapshot.
        if self.config.appendonly and self.aof_path.exists():
            applied, truncated = AppendOnlyFile.replay(self.aof_path, self._apply_replay)
            self.persistence.loaded_from = f"aof ({applied} commands, {truncated} truncated bytes)"
        elif self.snapshot_path.exists():
            n = snapshot.load(self.snapshot_path.read_bytes(), self.ks)
            self.persistence.loaded_from = f"snapshot ({n} keys)"
            if self.config.appendonly:
                # First start with AOF enabled on top of an existing snapshot: seed the AOF.
                self.aof_path.write_bytes(AppendOnlyFile.minimal_commands(self.ks))

    def _apply_replay(self, args: list[bytes]) -> None:
        cmd = REGISTRY.get(args[0].upper().decode())
        if cmd is None:
            raise ProtocolError(f"unknown command in AOF: {args[0]!r}")
        cmd.handler(Context(self, self.ks, None), args)

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        if self.replica_link:
            await self.replica_link.stop()
        if self._server:
            self._server.close()
            for c in list(self.clients.values()):
                c.writer.close()
            await self._server.wait_closed()
        if self._bg:
            await asyncio.gather(*self._bg, return_exceptions=True)
        if self.aof:
            self.aof.close()
        if self.config.save_on_shutdown and self.config.save_rules and self.persistence.dirty:
            self.save_snapshot_sync()

    # ---- client handling ------------------------------------------------------------------
    async def _handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        peer = writer.get_extra_info("peername")
        client = ClientState(addr=f"{peer[0]}:{peer[1]}" if peer else "?", writer=writer)
        self.clients[client.id] = client
        self.total_connections += 1
        parser = Parser()
        try:
            while True:
                data = await reader.read(65536)
                if not data:
                    break
                parser.feed(data)
                replies: list[bytes] = []
                close_after = False
                try:
                    while (args := parser.get_command()) is not None:
                        if not args:
                            continue
                        name = args[0].upper()
                        if name in (b"SYNC", b"PSYNC"):
                            writer.write(b"".join(replies))
                            await self._serve_replica(client, reader, writer, parser)
                            return
                        if name == b"QUIT":
                            replies.append(encode(OK))
                            close_after = True
                            break
                        replies.append(encode(self.execute(args, client), client.proto))
                except ProtocolError as exc:
                    replies.append(encode(RespError(f"ERR Protocol error: {exc}")))
                    close_after = True
                if self.aof:
                    # Durability BEFORE acknowledging: with 'always' the reply is only sent once
                    # the batch is on disk (one fsync per batch = group commit).
                    if self.aof.fsync_policy == "always":
                        self.aof.fsync()
                    else:
                        self.aof.flush()
                writer.write(b"".join(replies))
                await writer.drain()  # backpressure: slow reader -> we stop reading its commands
                if close_after:
                    break
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            self.clients.pop(client.id, None)
            self.replicas.pop(client.id, None)
            writer.close()

    def execute(self, args: list[bytes], client: ClientState | None, *, from_master: bool = False):
        """Run one command synchronously. Never awaits -> atomic with respect to other clients."""
        self.total_commands += 1
        if client:
            client.commands += 1
        cmd = REGISTRY.get(args[0].upper().decode("utf-8", "replace"))
        if cmd is None:
            return RespError(f"ERR unknown command '{args[0].decode('utf-8', 'replace')}'")
        try:
            check_arity(cmd, args)
            if cmd.write and self.replica_link is not None and not from_master:
                raise RespError("READONLY You can't write against a read only replica.")
            if cmd.may_grow and self.config.maxmemory and not from_master:
                if not self.ks.evict_until_fits(self.config.maxmemory, self.config.maxmemory_policy,
                                                self.config.maxmemory_samples):
                    raise RespError("OOM command not allowed when used memory > 'maxmemory'.")
            ctx = Context(self, self.ks, client)
            reply = cmd.handler(ctx, args)
        except RespError as exc:
            return exc
        if cmd.write:
            cmds = [args] if ctx.propagate is None else ctx.propagate
            for c in cmds:
                self._propagate(c)
            if cmds:
                self.persistence.dirty += 1
        return reply

    def apply_from_master(self, args: list[bytes]) -> None:
        reply = self.execute(args, None, from_master=True)
        if isinstance(reply, RespError):
            log.error("replica_apply_failed", extra={"cmd": args[0].decode(errors="replace"), "error": reply.message})

    def _propagate(self, cmd: list[bytes]) -> None:
        data = encode_command(cmd)
        if self.aof:
            self.aof.append(data)
        self.master_repl_offset += len(data)
        if self.replicas:
            # Batch the replication stream: one socket write per replica per loop iteration
            # instead of one per command. Measured ~2x on pipelined writes (see TESTING.md).
            self._repl_pending.append(data)
            if not self._repl_flush_scheduled:
                self._repl_flush_scheduled = True
                asyncio.get_running_loop().call_soon(self._flush_replication)

    def _flush_replication(self) -> None:
        self._repl_flush_scheduled = False
        if not self._repl_pending:
            return
        chunk = b"".join(self._repl_pending)
        self._repl_pending.clear()
        for r in list(self.replicas.values()):
            r.writer.write(chunk)

    # ---- replication (master side) -------------------------------------------------------------
    async def _serve_replica(self, client: ClientState, reader, writer, parser: Parser) -> None:
        client.is_replica = True
        self._flush_replication()                 # pending bytes belong to the OLD replicas only
        payload = snapshot.dump(self.ks)          # consistent: built synchronously
        # The replica counts ACK offsets from 0 = this snapshot; remember where that is in OUR stream.
        client.repl_base = self.master_repl_offset
        writer.write(b"$" + str(len(payload)).encode() + b"\r\n" + payload)
        self.replicas[client.id] = client          # from now on it receives every propagated write
        log.info("replica_attached", extra={"replica": client.addr, "snapshot_bytes": len(payload)})
        try:
            await writer.drain()
            while True:
                while (args := parser.get_command()) is not None:
                    if len(args) == 3 and args[0].upper() == b"REPLCONF" and args[1].upper() == b"ACK":
                        client.ack_offset = int(args[2])
                data = await reader.read(4096)
                if not data:
                    break
                parser.feed(data)
        except (ConnectionError, asyncio.IncompleteReadError, ValueError):
            pass
        finally:
            self.replicas.pop(client.id, None)
            log.info("replica_detached", extra={"replica": client.addr})

    def become_replica_of(self, host: str, port: int) -> None:
        if self.replica_link:
            asyncio.ensure_future(self.replica_link.stop())
        self.ks.is_replica = True
        self.replica_link = ReplicaLink(self, host, port)
        self.replica_link.start()

    def promote_to_master(self) -> None:
        if self.replica_link:
            asyncio.ensure_future(self.replica_link.stop())
        self.replica_link = None
        self.ks.is_replica = False

    # ---- persistence --------------------------------------------------------------------------
    def save_snapshot_sync(self) -> None:
        snapshot.write_atomic(self.snapshot_path, snapshot.dump(self.ks))
        self._snapshot_done(True)

    def _snapshot_done(self, ok: bool, saved_changes: int | None = None) -> None:
        """saved_changes: how many changes the snapshot contains. Changes made while a
        background save was running are NOT in the file, so they must stay 'dirty'."""
        self.persistence.last_bgsave_ok = ok
        if ok:
            self.persistence.last_save_time = time.time()
            if saved_changes is None:
                self.persistence.dirty = 0
            else:
                self.persistence.dirty = max(self.persistence.dirty - saved_changes, 0)
            self.persistence.snapshots_written += 1

    def start_bgsave(self) -> bool:
        """Real Redis fork()s and lets copy-on-write give the child a frozen view. Python on
        Windows can't fork, so: serialize in-loop (consistent, CPU-bound, blocks briefly), then
        do the slow disk I/O + fsync in a thread so clients keep being served."""
        if self.persistence.bgsave_in_progress:
            return False
        payload = snapshot.dump(self.ks)
        dirty_at_start = self.persistence.dirty
        self.persistence.bgsave_in_progress = True

        async def _write():
            try:
                await asyncio.to_thread(snapshot.write_atomic, self.snapshot_path, payload)
                self._snapshot_done(True, saved_changes=dirty_at_start)
            except Exception:
                log.exception("bgsave_failed")
                self._snapshot_done(False)
            finally:
                self.persistence.bgsave_in_progress = False

        self._spawn(_write())
        return True

    def start_aof_rewrite(self) -> bool:
        if not self.aof or self.aof.rewrite_in_progress:
            return False
        self._spawn(self.aof.rewrite(self.ks))
        return True

    def _spawn(self, coro) -> None:
        t = asyncio.create_task(coro)
        self._bg.add(t)
        t.add_done_callback(self._bg.discard)

    # ---- cron ---------------------------------------------------------------------------------
    async def _cron(self) -> None:
        interval = 1 / self.config.hz
        last_fsync = time.monotonic()
        while True:
            await asyncio.sleep(interval)
            try:
                self.ks.active_expire_cycle()
                if self.aof:
                    self.aof.flush()
                    if self.aof.fsync_policy == "everysec" and time.monotonic() - last_fsync >= 1:
                        last_fsync = time.monotonic()
                        await self.aof.fsync_in_thread()
                self._check_save_rules()
                self._check_replica_buffers()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("cron_error")

    def _check_save_rules(self) -> None:
        p = self.persistence
        if p.bgsave_in_progress or not p.dirty:
            return
        elapsed = time.time() - p.last_save_time
        for seconds, changes in self.config.save_rules:
            if elapsed >= seconds and p.dirty >= changes:
                self.start_bgsave()
                return

    def _check_replica_buffers(self) -> None:
        # A replica that can't keep up makes the master buffer its stream in memory forever.
        # Like Redis' client-output-buffer-limit: drop it; it will reconnect and full-sync.
        for r in list(self.replicas.values()):
            if r.writer.transport.get_write_buffer_size() > self.config.replica_output_buffer_limit:
                log.warning("replica_output_buffer_overflow", extra={"replica": r.addr})
                self.rejected_replica_buffers += 1
                r.writer.close()
                self.replicas.pop(r.id, None)

    # ---- INFO ---------------------------------------------------------------------------------
    def info(self, section: str = "all") -> str:
        s = {}
        s["server"] = {"minidis_version": "1.0.0", "process_id": os.getpid(), "tcp_port": self.port,
                       "uptime_in_seconds": int(time.time() - self.started_at)}
        s["clients"] = {"connected_clients": len(self.clients) - len(self.replicas)}
        s["memory"] = {"used_memory": self.ks.used_memory, "maxmemory": self.config.maxmemory,
                       "maxmemory_policy": self.config.maxmemory_policy.value,
                       "used_memory_note": "estimate (payload bytes + fixed per-entry overhead)"}
        s["persistence"] = {
            "loaded_from": self.persistence.loaded_from,
            "rdb_changes_since_last_save": self.persistence.dirty,
            "rdb_bgsave_in_progress": int(self.persistence.bgsave_in_progress),
            "rdb_last_save_time": int(self.persistence.last_save_time),
            "rdb_last_bgsave_status": {None: "none", True: "ok", False: "err"}[self.persistence.last_bgsave_ok],
            "aof_enabled": int(self.aof is not None),
            "aof_rewrite_in_progress": int(bool(self.aof and self.aof.rewrite_in_progress)),
            "aof_current_size": self.aof.size if self.aof else 0,
            "aof_fsync": self.aof.fsync_policy if self.aof else "-",
        }
        st = self.ks.stats
        s["stats"] = {"total_connections_received": self.total_connections,
                      "total_commands_processed": self.total_commands, "expired_keys": st.expired_keys,
                      "evicted_keys": st.evicted_keys, "keyspace_hits": st.keyspace_hits,
                      "keyspace_misses": st.keyspace_misses, "active_expire_cycles": st.active_expire_cycles,
                      "replica_buffer_disconnects": self.rejected_replica_buffers}
        if self.replica_link:
            rl = self.replica_link
            s["replication"] = {"role": "slave", "master_host": rl.host, "master_port": rl.port,
                                "master_link_status": "up" if rl.state == "connected" else "down",
                                "slave_repl_offset": rl.offset, "full_syncs": rl.full_syncs}
        else:
            rep = {"role": "master", "connected_slaves": len(self.replicas),
                   "master_repl_offset": self.master_repl_offset}
            for i, r in enumerate(self.replicas.values()):
                rep[f"slave{i}"] = (f"addr={r.addr},offset={r.repl_base + r.ack_offset},"
                                   f"lag_bytes={self.master_repl_offset - r.repl_base - r.ack_offset}")
            s["replication"] = rep
        s["keyspace"] = {"db0": f"keys={len(self.ks)},expires={len(self.ks.expires)}"}
        lines = []
        for name, kv in s.items():
            if section in ("all", "everything", "default", name):
                lines.append(f"# {name.capitalize()}")
                lines += [f"{k}:{v}" for k, v in kv.items()]
                lines.append("")
        return "\r\n".join(lines)
