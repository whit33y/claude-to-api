# claude-to-api

This project runs Claude (the Claude Code agent engine, through the **Claude Agent SDK**) in a Docker container, with a small password-protected HTTP API in front. You send it a message over HTTP and get Claude's answer back. Claude can also read and write files in a shared `workspace/` folder and run tools there.

```
your app / curl / bot ──HTTP(S)──▶ [Caddy on VPS] ──▶ container: API server ─▶ Claude Agent SDK ─▶ Claude
                                                          │
                                                          ├── ./workspace     files Claude can work on
                                                          └── ./data/claude   conversation history
```

**Contents**
1. [First-time setup](#1-first-time-setup)
2. [Everyday use: start, stop, logs](#2-everyday-use)
3. [Talking to Claude, step by step](#3-talking-to-claude-step-by-step)
4. [Using it from your own code](#4-using-it-from-your-own-code)
5. [Configuration (`.env`)](#5-configuration-env)
6. [Troubleshooting](#6-troubleshooting)
7. [Moving to a VPS](#7-moving-to-a-vps)
8. [API reference](#8-api-reference)

---

## 1. First-time setup

**Requirements**
- [Docker](https://docs.docker.com/get-docker/) with Docker Compose: Docker Desktop or OrbStack on a Mac, Docker Engine on Linux.
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/setup), only to create the subscription token (not needed if you use an API key). Install it with `npm install -g @anthropic-ai/claude-code`.
- A Claude Pro/Max subscription **or** an Anthropic API key.
- Optional: `jq` (nicer curl output) and Node.js 22+ (only to run the TypeScript examples or develop without Docker).

**Step 0: get the code.**
```bash
git clone https://github.com/whit33y/claude-to-api.git
cd claude-to-api
mkdir -p workspace data/claude
```

**Step 1: create the config file.**
```bash
cp .env.example .env
```
`.env` holds your secrets and is excluded by `.gitignore`. Never commit it.

**Step 2: get a Claude token.** This signs in with your Claude Pro/Max subscription in the browser and prints a token starting with `sk-ant-oat…`:
```bash
claude setup-token
```
Paste the token into `.env` after `CLAUDE_CODE_OAUTH_TOKEN=`, with no quotes or spaces.

> Using a pay-per-use API key from console.anthropic.com instead? Leave `CLAUDE_CODE_OAUTH_TOKEN` empty and set `ANTHROPIC_API_KEY=`. Use an API key if **anyone other than you** will use this API: a subscription is for personal use only.

**Step 3: set a password for the API.** Every request must send this value. Generate one:
```bash
openssl rand -hex 32
```
and paste it into `.env` after `API_TOKEN=`.

**Step 4: start it.**
```bash
docker compose up --build -d
```

**Step 5: check it's running.**
```bash
curl http://127.0.0.1:8787/health
```
You should see `{"ok":true,"credential":"oauth_token",...}`. If `credential` says `missing`, the token in `.env` wasn't picked up (see [Troubleshooting](#6-troubleshooting)).

---

## 2. Everyday use

| What | Command |
|---|---|
| Start (in the background) | `docker compose up -d` |
| Stop | `docker compose down` |
| See live logs | `docker compose logs -f app` |
| Apply changes to `.env` | `docker compose up -d` (the container is recreated) |
| Apply changes to the code in `src/` | `docker compose up --build -d` |
| Is it healthy? | `curl http://127.0.0.1:8787/health` |

Locally the API is at **`http://127.0.0.1:8787`** and can be reached only from this computer. Conversation history in `data/claude/` and files in `workspace/` survive restarts.

---

## 3. Talking to Claude, step by step

First, load your API password into the terminal once, so you don't have to paste it every time:
```bash
export API_TOKEN=$(grep ^API_TOKEN= .env | cut -d= -f2)
```

### 3.1 Ask a question
```bash
curl -s http://127.0.0.1:8787/v1/query \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"prompt": "What is the capital of Poland? Answer in one sentence."}' | jq
```
The answer is in `result`. **Save the `session_id`**: it's how you continue the conversation.

```json
{ "session_id": "dabb1bfe-…", "result": "The capital of Poland is Warsaw.", "is_error": false, "num_turns": 1, "total_cost_usd": 0.003, ... }
```

### 3.2 Continue the conversation
Send the `session_id` from the previous answer:
```bash
curl -s http://127.0.0.1:8787/v1/query \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"prompt": "And what is its population?", "session_id": "PASTE-SESSION-ID-HERE"}' | jq -r .result
```
Without `session_id`, every request starts a new conversation.

### 3.3 Get the answer live, word by word (streaming)
Add `?stream=1`, and `-N` so curl prints each piece as it arrives:
```bash
curl -N "http://127.0.0.1:8787/v1/query?stream=1" \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"prompt": "Write a short poem about Docker."}'
```
You'll see `event: text` lines as Claude writes, then a final `event: result`.

### 3.4 Let Claude work with files
By default Claude can only **read** (`Read`, `Grep`, `Glob`). To let it create or edit files, list the tools it may use and set `permission_mode` to `acceptEdits`. The shipped `.env.example` (set up for cr-app) allows only the read-only tools, so first widen it, e.g. `MAX_ALLOWED_TOOLS=Read,Grep,Glob,Edit,Write`, and run `docker compose up -d`; otherwise this request returns 400 `Tools not permitted on this server`:
```bash
curl -s http://127.0.0.1:8787/v1/query \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{
        "prompt": "Create notes.md with a 5-item checklist for deploying a website.",
        "allowed_tools": ["Read", "Write", "Edit", "Glob"],
        "permission_mode": "acceptEdits"
      }' | jq -r .result
```
The file appears in `./workspace/notes.md` on your computer. To have Claude work on an existing project, put the project in `workspace/` and point at it with `"cwd": "my-project"`.

Available tools: `Read`, `Grep`, `Glob` (reading); `Edit`, `Write` (changing files); `Bash` (running commands); `WebFetch`, `WebSearch` (internet). The server-side limit is `MAX_ALLOWED_TOOLS` in `.env`.

> ⚠️ `Bash` lets Claude run any command inside the container, including installing things, reaching the internet and reading environment variables. Allow it only for requests you trust.

### 3.5 Stop a long-running task
```bash
curl -X POST http://127.0.0.1:8787/v1/sessions/SESSION-OR-RUN-ID/abort -H "Authorization: Bearer $API_TOKEN"
```
Closing a streaming connection (Ctrl-C in curl) also stops the task.

### 3.6 Run the ready-made demos
```bash
./examples/curl.sh                          # question, follow-up, streaming + file write
npx tsx examples/client.ts "Hello!"         # streaming client in TypeScript
npx tsx examples/ai-sdk-client.ts           # Vercel AI SDK client
```
(Run `npm install` once first for the two TypeScript examples.)

---

## 4. Using it from your own code

Every request needs the header `Authorization: Bearer <API_TOKEN>`. Never put this token in code that runs in a browser or a mobile app, because anyone can read it there. Call the API from your own server.

### JavaScript / TypeScript (plain `fetch`)
```ts
const res = await fetch("http://127.0.0.1:8787/v1/query", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.API_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "Summarise this in one line: ...", session_id: previousSessionId }),
});
const data = await res.json();
console.log(data.result);          // the answer
previousSessionId = data.session_id; // keep for the next message
```
For a streaming client, see [`examples/client.ts`](examples/client.ts).

### Python
Needs `pip install requests`.
```python
import os, json, requests

URL = "http://127.0.0.1:8787/v1/query"
HEADERS = {"Authorization": f"Bearer {os.environ['API_TOKEN']}"}

# Simple answer
r = requests.post(URL, headers=HEADERS, json={"prompt": "Hello!"}, timeout=600)
data = r.json()
print(data["result"], data["session_id"])

# Streaming
with requests.post(URL + "?stream=1", headers=HEADERS, json={"prompt": "Tell me a story"}, stream=True) as r:
    for line in r.iter_lines(decode_unicode=True):
        if line and line.startswith("data:"):
            ev = json.loads(line[5:])
            if ev["type"] == "text":
                print(ev["text"], end="", flush=True)
```

### Vercel AI SDK (`useChat`, Next.js / React)
The endpoint **`/v1/ai-sdk/chat`** speaks the AI SDK's chat protocol, so `useChat` works with it directly. Claude still runs on your subscription in the container.

**1. Server route in your Next.js app.** It holds the token and forwards to the container:
```ts
// app/api/chat/route.ts
export async function POST(req: Request) {
  const body = await req.json();
  return fetch(`${process.env.CLAUDE_DOCKER_URL}/v1/ai-sdk/chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CLAUDE_DOCKER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, allowed_tools: ["Read", "Grep", "Glob"] }), // your server decides the tools
    signal: req.signal,
  });
}
```
Set `CLAUDE_DOCKER_URL=http://127.0.0.1:8787` and `CLAUDE_DOCKER_TOKEN=<API_TOKEN>` in the Next.js app's `.env.local`.

**2. Chat page:**
```tsx
// app/page.tsx
"use client";
import { useState } from "react";
import { useChat } from "@ai-sdk/react";

export default function Chat() {
  const { messages, sendMessage, status, stop } = useChat(); // posts to /api/chat
  const [input, setInput] = useState("");
  return (
    <div>
      {messages.map((m) => (
        <div key={m.id}>
          <b>{m.role}:</b>
          {m.parts.map((p, i) =>
            p.type === "text" ? <span key={i}>{p.text}</span>
            : p.type === "dynamic-tool" ? <i key={i}> [used {p.toolName}] </i>
            : null)}
        </div>
      ))}
      <form onSubmit={(e) => { e.preventDefault(); sendMessage({ text: input }); setInput(""); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} />
        {status === "streaming" ? <button type="button" onClick={stop}>Stop</button> : <button>Send</button>}
      </form>
    </div>
  );
}
```

How it behaves:
- Text streams in as `text` parts. Claude's tool use (Read, Write, Bash…) arrives as `dynamic-tool` parts, already executed on the server.
- The chat remembers context: the container links each `useChat` chat id to a Claude session, stored in `data/claude/ai-sdk-chats.json`.
- Each message's `metadata` holds `session_id`, `model`, `num_turns` and `total_cost_usd`.
- To start a chat over, use a new chat id, or call `DELETE /v1/ai-sdk/chat/<chat-id>`.
- "Regenerate" re-sends your last message; Claude can't erase what it already said in that session.

Testing straight from a browser page without a server route? Add the page's address to `CORS_ORIGINS` in `.env`. Only do this locally, because it exposes the token.

---

## 5. Configuration (`.env`)

After editing, run `docker compose up -d`.

`.env.example` is set up as the Claude backend for cr-app: `DEFAULT_MODEL=claude-sonnet-5-5`, `DEFAULT_EFFORT` / `MAX_EFFORT` = `high`, `MAX_ALLOWED_TOOLS=Read,Grep,Glob`. The Default column below is what the server uses when a variable is not set at all; note that an empty `MAX_ALLOWED_TOOLS=` or `DEFAULT_TOOLS=` means no tools, not the default list. Don't set `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`: they send every request to another endpoint and take precedence over `CLAUDE_CODE_OAUTH_TOKEN`.

| Variable | What it does | Default |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Subscription token from `claude setup-token` | — |
| `ANTHROPIC_API_KEY` | Alternative: pay-per-use API key | — |
| `API_TOKEN` | Password clients must send (at least 16 characters) | — (required) |
| `MAX_ALLOWED_TOOLS` | The most tools any request may enable | `Read,Grep,Glob,Edit,Write,Bash,WebFetch,WebSearch` |
| `DEFAULT_TOOLS` | Tools used when a request doesn't specify any | `Read,Grep,Glob` |
| `ALLOW_BYPASS` | Allow `permission_mode: "bypassPermissions"` | `false` |
| `DEFAULT_MODEL` | Model to use, e.g. `claude-sonnet-5-5`; empty = Claude Code's default | empty |
| `DEFAULT_EFFORT` | Reasoning effort when a request doesn't set one: `low`, `medium`, `high`, `xhigh`, `max`; empty = model default | empty |
| `MAX_EFFORT` | Highest `effort` a request may ask for (higher costs more tokens); empty = no limit | empty |
| `MAX_CONCURRENT_RUNS` | How many requests may run at once | `2` |
| `MAX_TURNS_CEILING` | Upper limit on agent steps per request | `50` |
| `CORS_ORIGINS` | Browser origins allowed to call the API directly | empty |
| `DOMAIN` | VPS only: your domain for HTTPS | — |

To make Claude follow standing instructions (house style, project rules), put a `CLAUDE.md` file in `workspace/`. Claude reads it automatically. For a single request, use `system_prompt_append`.

---

## 6. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `curl: (7) Failed to connect` | The container isn't running, or Docker isn't. Start Docker, then run `docker compose up -d` and check `docker compose ps`. |
| `{"error":"unauthorized"}` (401) | Wrong or missing `Authorization: Bearer …`. Run the `export API_TOKEN=…` line again. |
| `"result": "Not logged in · Please run /login"` | No Claude credential. Fill in `CLAUDE_CODE_OAUTH_TOKEN` in `.env`, then `docker compose up -d`. |
| `There's an issue with the selected model (…)` | `DEFAULT_MODEL` or the `model` field has a typo, or your plan doesn't include that model. Clear it or fix it. |
| `Tools not permitted on this server` (400) | A requested tool isn't in `MAX_ALLOWED_TOOLS`. |
| `Too many concurrent runs` (429) | Wait, or raise `MAX_CONCURRENT_RUNS`. |
| `That session is already running` (409) | One message per conversation at a time. Wait for the previous one to finish. |
| Claude says it can't write a file or run a command | That tool wasn't in `allowed_tools`. Check `permission_denials` in the reply. |
| Errors about usage limits | You've hit your subscription's limit. Wait for it to reset. |
| On the VPS: permission errors writing to `/workspace` | `sudo chown -R 1000:1000 workspace data` |
| Anything else | `docker compose logs -f app` |

---

## 7. Moving to a VPS

1. Install Docker on the VPS (Ubuntu: `curl -fsSL https://get.docker.com | sh`).
2. Point a DNS A record (for example `claude.example.com`) at the VPS IP and open ports 80 and 443.
3. On the VPS, get the code:
   ```bash
   git clone https://github.com/whit33y/claude-to-api.git ~/claude-to-api
   ```
   To update later, run `git pull` in that folder, then repeat the last command of step 4.
4. On the VPS:
   ```bash
   cd ~/claude-to-api
   cp .env.example .env
   mkdir -p workspace data/claude && sudo chown -R 1000:1000 workspace data   # container runs as uid 1000
   # edit .env (nano .env): your Claude token, a NEW long API_TOKEN, and DOMAIN=claude.example.com
   # (run `claude setup-token` on your own computer and paste the token; the VPS doesn't need Claude Code)
   docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build
   ```
5. Use `https://claude.example.com` in place of `http://127.0.0.1:8787` in every example above. Caddy gets and renews the HTTPS certificate automatically.

**Private alternative (recommended if only you will use it):** skip the domain and Caddy. Install [Tailscale](https://tailscale.com) on the VPS and on your devices, and change the port line in `docker-compose.yml` to `"<tailscale-ip>:8787:8787"`. The API is then never exposed to the internet.

---

## 8. API reference

Every `/v1/*` route requires `Authorization: Bearer $API_TOKEN`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Status (no auth) |
| POST | `/v1/query` | Send a message; JSON answer, or SSE with `?stream=1` |
| POST | `/v1/ai-sdk/chat` | Vercel AI SDK (`useChat`) compatible chat stream |
| DELETE | `/v1/ai-sdk/chat/:id` | Forget the Claude session behind an AI SDK chat |
| POST | `/v1/sessions/:id/abort` | Stop a running task (`run_id` or `session_id`) |
| GET | `/v1/sessions` | Recent runs and their status |

### `POST /v1/query` body
| Field | Required | Meaning |
|---|---|---|
| `prompt` | yes | Your message |
| `session_id` | no | Continue an earlier conversation |
| `allowed_tools` | no | Tools Claude may use, e.g. `["Read","Write"]` (default: `DEFAULT_TOOLS`) |
| `permission_mode` | no | `default` (deny anything not allowed), `acceptEdits`, `plan` (plan only, no changes), `bypassPermissions` (needs `ALLOW_BYPASS=true`) |
| `cwd` | no | Subfolder of `workspace/` to work in |
| `model` | no | e.g. `claude-sonnet-5-5` |
| `effort` | no | `low`, `medium`, `high`, `xhigh` or `max` (default: `DEFAULT_EFFORT`; rejected above `MAX_EFFORT`) |
| `system_prompt_append` | no | Extra instructions for this request |
| `max_turns` | no | Limit on agent steps (default 20) |
| `setting_sources` | no | Which settings Claude loads: any of `"user"`, `"project"`, `"local"` (default `["project"]`, i.e. `CLAUDE.md` and `.claude/settings.json` in `cwd`). Send `[]` when `cwd` holds untrusted code, so its hooks, MCP servers and `CLAUDE.md` are never loaded. With `restrict_to_cwd` the default is `[]` and only `"user"` is accepted |
| `restrict_to_cwd` | no | `true` denies file tools (`Read`, `Grep`, `Glob`, `Edit`, `Write`, …) any path outside `cwd`, after following symlinks — e.g. `/proc/self/environ`, `/home/node/.claude` or other folders of `workspace/`. Only `Read`, `Grep`, `Glob`, `Edit`, `Write` and `NotebookEdit` may be combined with it (no `Bash` or `WebFetch`). Denied calls show up in `permission_denials` |

**Running Claude on untrusted code** (e.g. reviewing a pull request): send `"setting_sources": []`, `"restrict_to_cwd": true` and read-only tools (`["Read","Grep","Glob"]`). Without them, instructions hidden in the code could make Claude read files elsewhere in the container, including the credential in the process environment. Also delete symlinks from the untrusted tree before the run: reads through a link that leaves `cwd` are blocked, but `Grep`/`Glob` may still walk into a linked directory.

`/v1/ai-sdk/chat` accepts the same optional fields next to `useChat`'s `id` and `messages`.

### JSON reply
```json
{ "run_id": "…", "session_id": "…", "result": "final answer", "is_error": false, "num_turns": 3,
  "total_cost_usd": 0.01, "usage": {…}, "permission_denials": [], "tool_events": [ … ] }
```
On a subscription, `total_cost_usd` is an estimate of what the request would cost on the API. You are not billed; it counts toward your plan's usage limits.

### Streaming events (`?stream=1`)
| event | data |
|---|---|
| `init` | `run_id`, `session_id`, `model`, `tools`, `cwd` |
| `text` | `{ "text": "next piece" }` |
| `tool_use` | `id`, `name`, `input`: Claude is using a tool |
| `tool_result` | `tool_use_id`, `is_error`, `content` (cut to 4 KB) |
| `result` | Same fields as the JSON reply; always the last event |
| `error` | `{ "message": "…" }` |

---

## Development without Docker
```bash
npm install
API_TOKEN=devtoken-devtoken WORKSPACE_DIR=$PWD/workspace npm run dev
```
