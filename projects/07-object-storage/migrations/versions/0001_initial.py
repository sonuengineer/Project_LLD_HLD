"""buckets, objects (versions), multipart, lifecycle, access keys, grants

Revision ID: 0001
Revises:
"""
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

STATEMENTS = [
    """CREATE TABLE access_keys (
      access_key_id text PRIMARY KEY,
      secret text NOT NULL,               -- needed to verify HMACs (like AWS); encrypt at rest in production
      owner text NOT NULL,
      is_admin boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz)""",
    """CREATE TABLE buckets (
      name text PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'),
      owner_key text NOT NULL REFERENCES access_keys(access_key_id),
      versioning text NOT NULL DEFAULT 'disabled' CHECK (versioning IN ('disabled', 'enabled', 'suspended')),
      public_read boolean NOT NULL DEFAULT false,
      quota_bytes bigint,
      created_at timestamptz NOT NULL DEFAULT now())""",
    """CREATE TABLE bucket_grants (
      bucket text NOT NULL REFERENCES buckets(name) ON DELETE CASCADE,
      access_key_id text NOT NULL REFERENCES access_keys(access_key_id) ON DELETE CASCADE,
      permission text NOT NULL CHECK (permission IN ('read', 'write')),
      PRIMARY KEY (bucket, access_key_id, permission))""",
    """CREATE TABLE objects (
      id bigserial PRIMARY KEY,
      bucket text NOT NULL REFERENCES buckets(name) ON DELETE CASCADE,
      key text NOT NULL,
      version_id text NOT NULL,           -- 'null' when versioning was never enabled (S3 semantics)
      is_latest boolean NOT NULL,
      is_delete_marker boolean NOT NULL DEFAULT false,
      size bigint NOT NULL DEFAULT 0,
      etag text,                          -- md5 hex, or "<md5 of part md5s>-<n>" for multipart
      sha256 text,
      content_type text,
      user_metadata jsonb NOT NULL DEFAULT '{}',
      blob_key text,                      -- random id in the storage adapter; NEVER derived from `key`
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (bucket, key, version_id))""",
    # Exactly one latest version per key -- enforced by the database, not just by code.
    "CREATE UNIQUE INDEX uq_objects_latest ON objects (bucket, key) WHERE is_latest",
    # Listing: prefix scans on (bucket, key) in order, latest only.
    "CREATE INDEX ix_objects_list ON objects (bucket, key text_pattern_ops) WHERE is_latest AND NOT is_delete_marker",
    "CREATE INDEX ix_objects_versions ON objects (bucket, key, created_at DESC)",
    "CREATE INDEX ix_objects_blob ON objects (blob_key)",
    """CREATE TABLE multipart_uploads (
      upload_id text PRIMARY KEY,
      bucket text NOT NULL REFERENCES buckets(name) ON DELETE CASCADE,
      key text NOT NULL,
      content_type text,
      user_metadata jsonb NOT NULL DEFAULT '{}',
      initiated_by text NOT NULL,
      initiated_at timestamptz NOT NULL DEFAULT now())""",
    """CREATE TABLE multipart_parts (
      upload_id text NOT NULL REFERENCES multipart_uploads(upload_id) ON DELETE CASCADE,
      part_number int NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
      size bigint NOT NULL,
      etag text NOT NULL,
      blob_key text NOT NULL,
      uploaded_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (upload_id, part_number))""",
    """CREATE TABLE lifecycle_rules (
      bucket text NOT NULL REFERENCES buckets(name) ON DELETE CASCADE,
      rule_id text NOT NULL,
      prefix text NOT NULL DEFAULT '',
      expiration_days int,
      noncurrent_expiration_days int,
      abort_multipart_days int,
      PRIMARY KEY (bucket, rule_id))""",
    # Blobs whose metadata is gone (overwritten / deleted) are queued here and deleted asynchronously,
    # so the request path never waits on (or fails because of) blob deletion.
    """CREATE TABLE blob_deletions (
      blob_key text PRIMARY KEY,
      queued_at timestamptz NOT NULL DEFAULT now())""",
]


def upgrade() -> None:
    for s in STATEMENTS:
        op.execute(s)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS blob_deletions, lifecycle_rules, multipart_parts, multipart_uploads, objects, "
                "bucket_grants, buckets, access_keys CASCADE")
