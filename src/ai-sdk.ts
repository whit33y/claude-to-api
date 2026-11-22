/**
 * Vercel AI SDK adapter: speaks the AI SDK "UI message stream" protocol so `useChat`
 * (or DefaultChatTransport) can talk to the Claude agent in this container.
 *
 * The AI SDK client sends the whole chat history on every request; Claude keeps its own
 * history server-side. We therefore send only the newest user message and map the
 * AI SDK chat `id` to a Claude `session_id` (persisted so it survives restarts).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Context } from "hono";
import { createUIMessageStream, createUIMessageStreamResponse, generateId } from "ai";
import { z } from "zod";
import { runAgent } from "./agent.js";
import { config, PolicyError, QueryRequest, resolveRun } from "./policy.js";
import * as sessions from "./sessions.js";

const UIPart = z.object({ type: z.string() }).passthrough();
const UIMessage = z.object({
  id: z.string().optional(),
  role: z.enum(["system", "user", "assistant"]),
  parts: z.array(UIPart),
});

/** useChat body + optional per-request agent options (send them via the transport's `body`). */
const ChatRequest = QueryRequest.omit({ prompt: true, session_id: true }).extend({
  id: z.string().min(1).max(200),
  messages: z.array(UIMessage).min(1),
  trigger: z.string().optional(),
});

// ---- chat id -> Claude session id (persisted in the ~/.claude volume) ----
const MAP_FILE = path.join(os.homedir(), ".claude", "ai-sdk-chats.json");
const chatMap: Record<string, string> = loadMap();

function loadMap(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(MAP_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveMap(): void {
  try {
    fs.mkdirSync(path.dirname(MAP_FILE), { recursive: true });
    fs.writeFileSync(MAP_FILE, JSON.stringify(chatMap));
  } catch (err) {
    console.error("could not persist chat map", err);
  }
}

function textOf(msg: z.infer<typeof UIMessage>): string {
  return msg.parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
}

/** Prompt for this turn: the newest user message, or the whole transcript if Claude has no session for this chat yet. */
function buildPrompt(messages: z.infer<typeof UIMessage>[], hasSession: boolean): string | null {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return null;
  const latest = textOf(lastUser);
  const earlier = messages.slice(0, messages.lastIndexOf(lastUser));
  if (hasSession || earlier.length === 0) return latest;
  // Unknown chat with history (e.g. created elsewhere): give Claude the earlier turns as context.
  const transcript = earlier.map((m) => `${m.role.toUpperCase()}: ${textOf(m)}`).join("\n\n");
  return `Earlier conversation for context:\n\n${transcript}\n\n---\n\n${latest}`;
}

export async function aiSdkChat(c: Context) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be JSON." }, 400);
  }
  const parsed = ChatRequest.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  const { id: chatId, messages, trigger: _trigger, ...agentOptions } = parsed.data;

  const sessionId = chatMap[chatId];
  const prompt = buildPrompt(messages, Boolean(sessionId));
  if (!prompt) return c.json({ error: "No user message with text found." }, 400);

  let spec;
  try {
    spec = resolveRun({ ...agentOptions, prompt, session_id: sessionId });
  } catch (err) {
    if (err instanceof PolicyError) return c.json({ error: err.message }, 400);
    throw err;
  }
  if (spec.resume && sessions.isSessionBusy(spec.resume)) return c.json({ error: "This chat is already running." }, 409);
  if (sessions.activeCount() >= config.maxConcurrentRuns) return c.json({ error: "Too many concurrent runs, try again later." }, 429);

  const run = sessions.startRun(prompt, spec.resume);
  c.req.raw.signal.addEventListener("abort", () => sessions.abort(run.runId)); // client pressed stop / disconnected

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      let textId: string | null = null;
      let streamedText = false;
      const closeText = () => {
        if (textId) writer.write({ type: "text-end", id: textId });
        textId = null;
      };

      writer.write({ type: "start" });
      for await (const ev of runAgent(run, spec)) {
        switch (ev.type) {
          case "init":
            if (chatMap[chatId] !== ev.session_id) {
              chatMap[chatId] = ev.session_id;
              saveMap();
            }
            writer.write({ type: "message-metadata", messageMetadata: { session_id: ev.session_id, model: ev.model } });
            break;
          case "text":
            if (!textId) {
              textId = generateId();
              writer.write({ type: "text-start", id: textId });
            }
            writer.write({ type: "text-delta", id: textId, delta: ev.text });
            streamedText = true;
            break;
          case "tool_use":
            closeText();
            writer.write({ type: "tool-input-available", toolCallId: ev.id, toolName: ev.name, input: ev.input, dynamic: true });
            break;
          case "tool_result":
            writer.write(
              ev.is_error
                ? { type: "tool-output-error", toolCallId: ev.tool_use_id, errorText: ev.content, dynamic: true }
                : { type: "tool-output-available", toolCallId: ev.tool_use_id, output: ev.content, dynamic: true },
            );
            break;
          case "result":
            closeText();
            if (ev.is_error) {
              writer.write({ type: "error", errorText: ev.result ?? ev.errors?.join("; ") ?? ev.subtype });
            } else if (!streamedText && ev.result) {
              // Nothing streamed (rare): deliver the final answer in one piece.
              const id = generateId();
              writer.write({ type: "text-start", id });
              writer.write({ type: "text-delta", id, delta: ev.result });
              writer.write({ type: "text-end", id });
            }
            writer.write({
              type: "finish",
              finishReason: ev.is_error ? "error" : "stop",
              messageMetadata: { session_id: ev.session_id, num_turns: ev.num_turns, total_cost_usd: ev.total_cost_usd },
            });
            break;
          case "error":
            closeText();
            writer.write({ type: "error", errorText: ev.message });
            break;
        }
      }
    },
    onError: (err) => (err instanceof Error ? err.message : String(err)),
  });

  return createUIMessageStreamResponse({ stream });
}

/** Forget the Claude session behind a chat (next message starts fresh). */
export function resetChat(c: Context) {
  const id = c.req.param("id") ?? "";
  const existed = id in chatMap;
  delete chatMap[id];
  saveMap();
  return c.json({ reset: existed });
}
