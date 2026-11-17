from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All configuration comes from environment variables (prefix RL_)."""

    model_config = SettingsConfigDict(env_prefix="RL_", env_file=".env", extra="ignore")

    redis_url: str = "redis://127.0.0.1:56379/0"
    # Small but not tiny: a 50ms timeout measured event-loop lag under load, not Redis
    # latency, and produced false "Redis down" decisions (see TESTING.md, load test notes).
    redis_socket_timeout: float = 0.25
    redis_connect_timeout: float = 0.2
    redis_max_connections: int = 200
    redis_pool_timeout: float = 0.1  # max wait for a free pooled connection
    policies_file: Path = Path(__file__).parent / "policies.json"
    policy_cache_ttl_seconds: float = 5.0
    api_key_cache_ttl_seconds: float = 30.0
    admin_token: str = "change-me-admin-token"
    # Trust X-Forwarded-For only when running behind our own proxy (nginx).
    trust_forwarded_for: bool = False
    instance_name: str = "rl-local"
    log_level: str = "INFO"
    log_json: bool = True


def get_settings() -> Settings:
    return Settings()
