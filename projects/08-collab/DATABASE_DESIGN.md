# Database Design -- Collaborative Editing

```mermaid
erDiagram
  USERS ||--o{ DOCUMENT_PERMISSIONS : has
  DOCUMENTS ||--o{ DOCUMENT_PERMISSIONS : grants
  DOCUMENTS ||--o{ OPERATIONS : "op log"
  DOCUMENTS ||--o{ SNAPSHOTS : "every N revs"
  DOCUMENTS { uuid id PK text title uuid owner_id text content bigint rev }
  OPERATIONS { uuid document_id PK bigint rev PK jsonb op uuid user_id text client_id bigint client_seq }
  SNAPSHOTS { uuid document_id PK bigint rev PK text content }
  DOCUMENT_PERMISSIONS { uuid document_id PK uuid user_id PK text role }
```

- `documents.content` + `documents.rev`: current state; the row is the per-document lock.
- `operations (document_id, rev)` PK: the total order. Stored op is the TRANSFORMED op (applies to rev-1),
  so history replay is a plain left fold.
- `UNIQUE (document_id, client_id, client_seq)`: idempotent resend after a lost ack.
- `snapshots`: rev 0 at creation and every `snapshot_every` revs; `content_at(rev)` = nearest snapshot
  <= rev + replay. Bounded reconstruction cost.
- Restore never rewrites history: it appends a new op (diff from current to old content).

Retention / compaction (not implemented, documented): ops older than the newest snapshot could be
archived, at the cost of losing per-edit history beyond it.
