from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="WH_", env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p04_webhooks"
    redis_url: str = "redis://127.0.0.1:56379/4"
    api_token: str = "change-me-wh-token"
    # Retry schedule in seconds after attempt 1, 2, ... (jitter +-20% applied). Length+1 = max attempts.
    retry_schedule_seconds: list[float] = [5, 30, 120, 600, 1800, 3600, 3 * 3600, 6 * 3600]
    connect_timeout_seconds: float = 3.0
    request_timeout_seconds: float = 10.0
    lease_seconds: float = 30.0                  # in-flight lease; expired -> another dispatcher retries
    auto_disable_after_failures: int = 20        # consecutive failed attempts -> endpoint disabled
    default_rate_limit_per_second: float = 10.0
    allow_private_destinations: bool = False     # SSRF guard; true only for local dev / tests
    max_response_snippet: int = 1024
    log_level: str = "INFO"
    log_json: bool = True


def get_settings() -> Settings:
    return Settings()
