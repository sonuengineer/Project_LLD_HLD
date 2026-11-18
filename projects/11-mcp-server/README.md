# interview-mcp -- a hand-written MCP server (A3)

An MCP (Model Context Protocol) server that lets Claude, or any MCP client, search and quiz you on the interview
banks in `interview/data` (10 project banks + the cross-project system-design bank).

The protocol layer is written from scratch (about 250 lines, **zero runtime dependencies**). The official
`@modelcontextprotocol/sdk` is a **dev dependency only**: a test connects its real client to this server to prove the
hand-written protocol is spec-compatible.

## What MCP is, in one paragraph

MCP is JSON-RPC 2.0 with a fixed set of method names. A client (Claude Code, Claude Desktop, an IDE) starts your
program as a child process and exchanges one JSON message per line over stdin/stdout. The client sends `initialize`,
the server answers with what it can do, then the client calls `tools/list` and `tools/call`. The model reads each tool's
**description** and decides by itself when to call it.

## Tools

| Tool | Arguments | Use |
|---|---|---|
| `list_projects` | none | slugs, names, question counts, difficulty split |
| `search_questions` | `query`, optional `project`, `category`, `difficulty`, `limit` (1-25, default 10) | find ids by keyword |
| `get_question` | `id` (e.g. `PAYS-001`) | full question: Hinglish answer, internals, files, code, pitfalls, follow-ups |
| `random_questions` | optional `project`, `category`, `difficulty`, `count` (1-10, default 3) | quiz mode; returns questions only, no answers |
| `get_pitch` | `project`, optional `section` (default `intro_30s`, or `all`) | "explain this project" material |

`project` accepts a full slug (`p09-payments`) or any unique part (`payments`, `p09`). An ambiguous value is an error that
lists the matches, never a guess.

## Run and test

```bash
cd projects/11-mcp-server
npm install
npm test            # builds, then runs 58 tests (about 4 s)
npm run build       # -> dist/index.js
```

Environment: `INTERVIEW_DATA_DIR` overrides the data folder (default: `../../interview/data` relative to the repo).

## Connect it to Claude Code

```bash
claude mcp add interview -- node H:/project/projects/11-mcp-server/dist/index.js
```

Then ask, for example: "Quiz me with 3 advanced questions on payments", "Show PAYS-001", "Give me the 2-minute pitch for p05".
Remove it with `claude mcp remove interview`.

## What the wire looks like (real output of this server)

Client -> server (one line each), server -> client replies below. `instructions` shortened here.

```
-> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"hand","version":"0"}}}
<- {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"interview-mcp","version":"1.0.0"},"instructions":"..."}}

-> {"jsonrpc":"2.0","method":"notifications/initialized"}
<- (nothing: a notification has no id, so it gets no reply)

-> {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_questions","arguments":{"query":"double charge","project":"payments","limit":2}}}
<- {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"2 result(s):\nPAYS-001  [Beginner | Fundamentals]  What are the two failures ...\nPAYS-005  [Intermediate | Fundamentals]  What is a double-entry ledger ..."}]}}

-> {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_question","arguments":{"id":"nope"}}}
<- {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"no question with id \"nope\". Use search_questions to find ids."}],"isError":true}}
```

## Design decisions

| Decision | Why |
|---|---|
| Protocol layer hand-written, SDK only in tests | the goal is to understand MCP; the SDK client is a free, independent spec checker |
| `protocol.ts` has no I/O, `stdio.ts` has no meaning | the core takes one parsed message and returns one response, so it is unit-testable without processes or streams |
| Bad arguments -> `isError: true` result; unknown tool -> JSON-RPC error `-32602` | an `isError` result stays inside the conversation, so the model reads the message and retries with fixed arguments |
| Crashes never reach the client | the detail goes to stderr; the client only sees "tool failed unexpectedly" / "internal error" |
| Tool schemas are plain objects used both for `tools/list` and for validation | one definition, no drift |
| Keyword scoring, no embeddings | explainable (title 5, concept tag 4, category 2, body 1; exact id wins) and good enough for about 1,100 curated records |
| Everything loaded once at startup, read-only | no writes, no network, no secrets; a bad data file fails loudly at start, not mid-session |

## Security notes

- **stdout is the protocol.** Nothing else may be written there; logs go to stderr.
- **Tool arguments come from an LLM** and are treated as untrusted: type, range, enum, length, and unknown keys are all
  checked (`hasOwn`, so `constructor` is not a "known" key).
- Results are capped at 60,000 characters so one call cannot flood the model's context.
- Question text is data, not instructions. The banks are written by the repo owner; if you ever load banks from an
  untrusted source, a question's text could try to steer the model (prompt injection), so review such banks first.
- No file path ever comes from a client: the data directory is fixed at startup.

## Known limits

- Tools only. No `resources`, `prompts`, `completions`, logging or progress: this server advertises none of them, so
  requests for them get `method not found`.
- No pagination in `tools/list` (five tools).
- JSON-RPC batches are rejected (removed from MCP since 2025-06-18).
- Search is lexical: "double charge" will not find a question that only says "paid twice".
- stdio only (local child process). A remote HTTP transport would need authentication and is not built.
- Tested with the official SDK client over stdio. Not tested inside Claude Desktop or an IDE.

## Files

| File | Role |
|---|---|
| `src/jsonrpc.ts` | JSON-RPC 2.0 types, error codes, response helpers |
| `src/protocol.ts` | `McpServer`: initialize/version negotiation, tools/list, tools/call, lifecycle rules |
| `src/schema.ts` | argument validation and `ToolError` |
| `src/data.ts` | loads the banks, project resolution, search scoring, random pick |
| `src/tools.ts` | the five tools and question rendering |
| `src/stdio.ts` | newline-delimited JSON over streams |
| `src/index.ts` | entry point |
| `test/*.test.ts` | protocol (17), tools and data (30), stdio framing (5), official-SDK interop on real data (6) |
