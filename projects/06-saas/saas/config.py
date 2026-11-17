from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SAAS_", env_file=".env", extra="ignore")

    # The app connects as saas_app: NOT the table owner and NOT a superuser, otherwise
    # Postgres row-level security would be bypassed.
    database_url: str = "postgresql+asyncpg://saas_app:saas_app_dev@127.0.0.1:55432/p06_saas"
    migration_database_url: str = "postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p06_saas"
    app_db_password: str = "saas_app_dev"
    redis_url: str = "redis://127.0.0.1:56379/6"
    jwt_secret: str = "change-me-jwt-secret-at-least-32-bytes-long!!"
    access_token_ttl_seconds: int = 900
    refresh_token_ttl_seconds: int = 30 * 24 * 3600
    billing_webhook_secret: str = "whsec_mock_billing_secret"
    platform_admin_emails: list[str] = []
    cache_ttl_seconds: int = 60
    bcrypt_rounds: int = 12
    log_level: str = "INFO"
    log_json: bool = True


def get_settings() -> Settings:
    return Settings()
