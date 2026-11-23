## Project context

A small Hono HTTP server (TypeScript, ESM, Node 22) that wraps the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) behind a bearer-token API, packaged in Docker. Clients POST a prompt; the server runs a Claude Code agent session in `WORKSPACE_DIR` and returns JSON, SSE, or a Vercel AI SDK UI-message stream. The README is user-facing docs (setup, API reference, troubleshooting) and should be kept in sync when the API or `.env` options change.

## Commands

```bash
npm install
API_TOKEN=devtoken-devtoken WORKSPACE_DIR=$PWD/workspace npm run dev   # tsx watch, no Docker
npm run typecheck                                                      # tsc --noEmit
npm run build                                                          # -> dist/

docker compose up --build -d          # rebuild after changes to src/
docker compose up -d                  # apply .env changes (recreates container)
docker compose logs -f app
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build   # VPS: adds Caddy TLS, unpublishes 8787
```

There is no test suite and no linter; `npm run typecheck` is the only automated check. Verify behavior manually with `examples/curl.sh` or the TS examples in `examples/`. The server refuses to start unless `API_TOKEN` is ≥16 chars.

## Architecture

Request flow: `server.ts` (routes, auth, CORS) → `policy.ts` `resolveRun()` → `sessions.ts` `startRun()` → `agent.ts` `runAgent()` → SDK `query()`.

- **`policy.ts`** — the security boundary. `config` is read once from env. `QueryRequest` (zod) is the shared request schema; `resolveRun()` turns it into a `ResolvedRun`, enforcing server ceilings: requested tools must be a subset of `MAX_ALLOWED_TOOLS`, `cwd` must resolve inside the workspace, `effort` ≤ `MAX_EFFORT`, `max_turns` capped by `MAX_TURNS_CEILING`, `bypassPermissions` only with `ALLOW_BYPASS=true`. Because the server is headless, permission mode `"default"` is mapped to the SDK's `"dontAsk"` (deny anything not pre-approved). `childEnv()` strips `API_TOKEN` from the agent subprocess env. Any new request option should be added to `QueryRequest`, validated in `resolveRun`, and passed through in `agent.ts`.
- **`agent.ts`** — calls `query()` with `tools` and `allowedTools` both set to the resolved list (what exists *and* is pre-approved), `settingSources: ["project"]` (so a `CLAUDE.md`/`.claude/settings.json` inside the *workspace* affects the agent — not this repo's), and partial messages on. `mapMessage()` normalizes SDK messages into the `AgentEvent` union (`init`/`text`/`tool_use`/`tool_result`/`result`/`error`), which is the single internal event format consumed by all endpoints. Only top-level text deltas are emitted (subagent output is filtered by `parent_tool_use_id`); tool results are truncated to 4 KB. A non-zero CLI exit after a `result` was already delivered is treated as success.
- **`sessions.ts`** — in-memory run registry (not persisted; last 200 runs). Tracks run status, maps runs to Claude `session_id` (set on the `init` event), and owns each run's `AbortController`. Used for the concurrency limit (429), one-run-per-session lock (409), and abort by run id or session id. Client disconnect aborts the run.
- **`server.ts`** — `/v1/query` emits `AgentEvent`s directly as SSE (`?stream=1` or `Accept: text/event-stream`), or collects them into a single JSON reply (`tool_events` + result fields).
- **`ai-sdk.ts`** — adapter for Vercel AI SDK `useChat`. The client sends the full history each time, but Claude keeps history server-side, so only the newest user message is sent; the AI SDK chat `id` → Claude `session_id` mapping is persisted to `~/.claude/ai-sdk-chats.json`. For an unknown chat id with prior messages, the earlier turns are inlined into the prompt as context. Translates `AgentEvent`s into UI-message-stream parts (`text-start/delta/end`, dynamic `tool-*` parts, `finish`).

## Runtime/deployment notes

- Persistent state lives in two bind mounts: `./workspace` → `/workspace` (agent's files) and `./data/claude` → `/home/node/.claude` (SDK session history needed for `resume`, plus the AI SDK chat map). Container runs as uid 1000.
- Credentials: `CLAUDE_CODE_OAUTH_TOKEN` (subscription, from `claude setup-token`) or `ANTHROPIC_API_KEY`; `/health` reports which one is present. All policy knobs are documented in `.env.example`.
- System tools available to the agent's Bash are whatever the runtime stage of the `Dockerfile` installs.
