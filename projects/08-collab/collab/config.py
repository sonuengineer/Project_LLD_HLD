from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="COLLAB_", env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p08_collab"
    redis_url: str = "redis://127.0.0.1:56379/8"
    server_id: str = "collab-1"
    snapshot_every: int = 50                  # store full content every N revisions (history reconstruction)
    max_document_chars: int = 1_000_000
    max_op_components: int = 10_000
    ws_ticket_ttl_seconds: int = 30
    gap_fill_delay_ms: int = 300              # wait this long for a missing revision before reading it from DB
    tail_check_ms: int = 1000                 # how often each server compares its rooms with the DB head (tail loss)
    presence_stale_seconds: int = 30
    log_level: str = "INFO"
    log_json: bool = True


def get_settings() -> Settings:
    return Settings()
