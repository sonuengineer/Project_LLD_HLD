from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PAY_", env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p09_payments"
    provider_url: str = "http://127.0.0.1:8019"
    provider_api_key: str = "mock_provider_key"
    provider_timeout_seconds: float = 1.0
    provider_webhook_secret: str = "whsec_mock_provider"
    admin_token: str = "change-me-pay-admin"
    stuck_after_seconds: float = 30.0         # intermediate states older than this are resolved by recovery
    idempotency_lock_seconds: float = 60.0    # an in-progress idempotent request is considered abandoned after this
    log_level: str = "INFO"
    log_json: bool = True


def get_settings() -> Settings:
    return Settings()
