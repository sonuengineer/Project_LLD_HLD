from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="FLOW_", env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p10_workflows"
    workflow_task_lease_seconds: float = 10.0
    poll_interval_seconds: float = 0.1
    admin_token: str = "change-me-flow-admin"
    log_level: str = "INFO"
    log_json: bool = True


def get_settings() -> Settings:
    return Settings()
