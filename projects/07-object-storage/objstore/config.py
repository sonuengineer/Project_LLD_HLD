from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="OBJ_", env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p07_object_store"
    storage_backend: str = "local"             # local | s3
    local_root: str = "./blobs"
    s3_endpoint: str = "http://127.0.0.1:58333"
    s3_bucket: str = "objstore-blobs"
    s3_access_key: str = "objstore"
    s3_secret_key: str = "objstore-secret"
    s3_region: str = "us-east-1"
    admin_token: str = "change-me-obj-admin"
    max_object_bytes: int = 5 * 1024 ** 3      # single PUT limit (S3: 5 GiB)
    min_part_bytes: int = 5 * 1024 ** 2        # every part except the last (S3: 5 MiB)
    clock_skew_seconds: int = 900              # signed request date tolerance
    max_presign_seconds: int = 7 * 24 * 3600
    orphan_grace_seconds: int = 3600           # GC never deletes blobs younger than this
    deletion_grace_seconds: int = 300          # queued (overwritten/deleted) blobs live this long: in-flight GETs finish
    public_base_url: str = "http://127.0.0.1:8007"
    log_level: str = "INFO"
    log_json: bool = True


def get_settings() -> Settings:
    return Settings()
