from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="JQ_", env_file=".env", extra="ignore")

    redis_url: str = "redis://127.0.0.1:56379/1"
    database_url: str = "postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p03_job_queue"
    key_prefix: str = "jq:"
    api_token: str = "change-me-jq-token"
    job_retention_seconds: int = 24 * 3600
    completed_cap: int = 1000
    idempotency_ttl_seconds: int = 24 * 3600
    lease_grace_ms: int = 5000
    max_lease_ms: int = 30000          # leases are extended while the worker is alive
    reap_interval_seconds: float = 2.0
    log_level: str = "INFO"
    log_json: bool = True


def get_settings() -> Settings:
    return Settings()
