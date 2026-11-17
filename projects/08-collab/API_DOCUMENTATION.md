# API -- Collaborative Editing

## HTTP (Bearer user token)

| Method | Path | Notes |
|---|---|---|
| POST | `/users` | `{name}` -> `{user_id, token}` (demo signup) |
| POST | `/ws-tickets` | one-time ticket for `/ws?ticket=` (30s) |
| POST | `/docs` | `{title, content?}` -> owner |
| GET | `/docs`, `/docs/{id}` | list mine / content + rev + role |
| POST | `/docs/{id}/share` | owner: `{user_id, role: editor|viewer}`; 409 for the owner's own row; open sockets of that user switch role live |
| DELETE | `/docs/{id}/share/{user_id}` | owner: revoke; that user's sockets are closed (4403) on every server |
| GET | `/docs/{id}/history?limit=&before=` | rev, time, user, chars inserted/deleted |
| GET | `/docs/{id}/revisions/{rev}` | content at that revision |
| POST | `/docs/{id}/restore/{rev}` | editor: new revision equal to old content (live) |
| GET | `/docs/{id}/presence` | who is connected (all servers) |
| GET | `/stats` | server id, rooms, published/received, gap fills |
| GET | `/editor` | browser demo |

## WebSocket protocol (`/ws?ticket=...`, JSON messages)

Client -> server:

| type | fields | meaning |
|---|---|---|
| `join` | `doc_id, client_id, last_rev?` | first message; `last_rev` = reconnect catch-up. The server stores `client_id` as `<user_id>:<client_id>` |
| `op` | `client_seq, base_rev, op` | op = `[retain:int>0 | insert:str | delete:int<0, ...]` covering the doc at base_rev |
| `cursor` | `position, selection_end?, rev` | ephemeral |
| `ping` | | keepalive / presence refresh |

Server -> client:

| type | fields |
|---|---|
| `joined` | `rev, content?, catchup, conn_id, presence` |
| `op` | `rev, op, user_id, client_id` (transform your pending ops against it) |
| `ack` | `rev, client_seq` (your op got this revision) |
| `presence` | `event: join|leave, conn_id, user_id, name` |
| `cursor` | `conn_id, user_id, name, position, rev` |
| `role` | `role` (your access changed while connected) |
| `error` | `code (invalid_operation, forbidden, access_revoked, ...), message, client_seq?` -- if `client_seq` is your in-flight op, resync (reload the document) |
| `pong` | |

Close codes: 4401 bad ticket, 4403 no access, 4400 malformed, 1013 client too slow (reconnect).
