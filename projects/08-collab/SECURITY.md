# Security -- Collaborative Editing

| Threat | Mitigation | Code |
|---|---|---|
| Token leakage via WS URL (logs, proxies, history) | one-time, 30s tickets exchanged for the bearer token; consumed with GETDEL | `/ws-tickets`, `/ws` |
| Unauthorized read | role check on join; non-members get "not found" | `service.require_role` |
| Unauthorized write | viewers' ops rejected per message (fast path) AND the role is re-checked inside the sequencer transaction for every op | `api.py` op handler, `service.submit` |
| Access revoked while connected | `DELETE /docs/{id}/share/{user}` publishes a `perm` event: every server closes that user's sockets (4403); a downgrade switches the cached role. If the event is lost, `service.submit` still rejects writes | `Hub._apply_permission`, `test_revoking_access_closes_sockets_and_sequencer_rejects` |
| Owner locks itself out | share/revoke never modify the owner's row (409) | `api.share`, `api.unshare` |
| client_id hijacking (client_id is visible to everyone in op messages) | server namespaces it as `<user_id>:<client_id>`, so another user cannot steal acks or make your ops look like duplicates | `ws_endpoint`, `test_client_id_of_another_user_cannot_be_hijacked` |
| Malicious ops (wrong length, huge, weird types) | parsed and validated; must apply exactly to the document; size limits | `service.submit`, `TextOp.from_json` |
| Document bloat | max document size, max op components | settings |
| Replay of an old op | (client_id, client_seq) uniqueness; ops are bound to a base revision | DB constraint |
| XSS in the demo page | names escaped before rendering | `editor.html` |
| Slow-client DoS on a room | bounded per-connection queue; on overflow the socket is closed immediately (1013) and the client reconnects + catches up | `Conn.send`, `Conn.kick` |
| Cross-site WebSocket hijacking | tickets required (cookies alone don't authenticate) | `/ws` |

Gaps: demo signup issues tokens without passwords; no rate limiting on ops/cursors per user; no Origin check
on `/ws` (tickets mitigate CSWSH); no bound on how stale `base_rev` may be (a very old base means a long
transform under the document lock); no TLS in compose; no per-document audit of permission changes.
