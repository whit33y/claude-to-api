import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import { runAgent, type AgentEvent } from "./agent.js";
import { aiSdkChat, resetChat } from "./ai-sdk.js";
import { config, PolicyError, QueryRequest, resolveRun } from "./policy.js";
import * as sessions from "./sessions.js";

if (!config.apiToken || config.apiToken.length < 16) {
  console.error("API_TOKEN must be set (at least 16 characters). Refusing to start.");
  process.exit(1);
}

const app = new Hono();

const hash = (s: string) => createHash("sha256").update(s).digest();
const expected = hash(config.apiToken);
const requireToken: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!timingSafeEqual(hash(token), expected)) return c.json({ error: "unauthorized" }, 401);
  await next();
};

app.get("/health", (c) =>
  c.json({
    ok: true,
    credential: process.env.CLAUDE_CODE_OAUTH_TOKEN ? "oauth_token" : process.env.ANTHROPIC_API_KEY ? "api_key" : "missing",
    active_runs: sessions.activeCount(),
  }),
);

// Browser apps on another origin (e.g. a Next.js app using useChat) need CORS. Comma-separated list in CORS_ORIGINS.
if (config.corsOrigins.length) {
  app.use("/v1/*", cors({ origin: config.corsOrigins, allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["GET", "POST", "DELETE", "OPTIONS"] }));
}

app.use("/v1/*", requireToken);

app.post("/v1/query", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be JSON." }, 400);
  }
  const parsed = QueryRequest.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);

  let spec;
  try {
    spec = resolveRun(parsed.data);
  } catch (err) {
    if (err instanceof PolicyError) return c.json({ error: err.message }, 400);
    throw err;
  }
  if (spec.resume && sessions.isSessionBusy(spec.resume)) return c.json({ error: "That session is already running." }, 409);
  if (sessions.activeCount() >= config.maxConcurrentRuns) return c.json({ error: "Too many concurrent runs, try again later." }, 429);

  const run = sessions.startRun(spec.prompt, spec.resume);
  const wantsStream = c.req.query("stream") === "1" || (c.req.header("accept") ?? "").includes("text/event-stream");

  if (wantsStream) {
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => {
        sessions.abort(run.runId); // client disconnected
      });
      for await (const ev of runAgent(run, spec)) {
        await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
      }
    });
  }

  // Non-streaming: collect everything and answer once.
  c.req.raw.signal.addEventListener("abort", () => sessions.abort(run.runId));
  const tools: AgentEvent[] = [];
  let result: Extract<AgentEvent, { type: "result" }> | undefined;
  let error: string | undefined;
  for await (const ev of runAgent(run, spec)) {
    if (ev.type === "tool_use" || ev.type === "tool_result") tools.push(ev);
    else if (ev.type === "result") result = ev;
    else if (ev.type === "error") error = ev.message;
  }
  if (!result) return c.json({ run_id: run.runId, session_id: run.sessionId ?? null, error: error ?? "No result" }, 502);
  const { type: _type, ...payload } = result;
  return c.json({ run_id: run.runId, ...payload, tool_events: tools }, result.is_error ? 500 : 200);
});

// Vercel AI SDK (useChat / DefaultChatTransport) compatible endpoint.
app.post("/v1/ai-sdk/chat", aiSdkChat);
app.delete("/v1/ai-sdk/chat/:id", resetChat);

app.post("/v1/sessions/:id/abort", (c) => {
  const ok = sessions.abort(c.req.param("id"));
  return ok ? c.json({ aborted: true }) : c.json({ error: "No running run with that id." }, 404);
});

app.get("/v1/sessions", (c) => c.json({ runs: sessions.list() }));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});

serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`claude-docker API listening on :${info.port} (workspace ${config.workspaceDir})`);
  console.log(`tool ceiling: ${config.maxAllowedTools.join(", ")}; bypass ${config.allowBypass ? "ENABLED" : "disabled"}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    for (const r of sessions.list()) if (r.status === "running") sessions.abort(r.runId);
    process.exit(0);
  });
}
