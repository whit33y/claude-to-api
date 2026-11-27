import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { childEnv, type ResolvedRun } from "./policy.js";
import { finishRun, type Run } from "./sessions.js";

/** Events this API emits, both over SSE and (collected) in the JSON response. */
export type AgentEvent =
  | { type: "init"; run_id: string; session_id: string; model: string; tools: string[]; cwd: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; is_error: boolean; content: string }
  | {
      type: "result";
      session_id: string;
      subtype: string;
      is_error: boolean;
      result: string | null;
      errors?: string[];
      num_turns: number;
      duration_ms: number;
      total_cost_usd: number;
      usage: unknown;
      permission_denials: unknown[];
    }
  | { type: "error"; message: string };

const TOOL_RESULT_MAX = 4000;

/** Run one prompt through the Claude Agent SDK and yield normalized events. */
export async function* runAgent(run: Run, spec: ResolvedRun): AsyncGenerator<AgentEvent> {
  let sawResult = false;
  try {
    const stream = query({
      prompt: spec.prompt,
      options: {
        cwd: spec.cwd,
        resume: spec.resume,
        model: spec.model,
        effort: spec.effort,
        maxTurns: spec.maxTurns,
        tools: spec.tools, // what exists
        allowedTools: spec.tools, // and is pre-approved
        permissionMode: spec.permissionMode,
        allowDangerouslySkipPermissions: spec.permissionMode === "bypassPermissions",
        systemPrompt: { type: "preset", preset: "claude_code", append: spec.systemPromptAppend },
        settingSources: ["project"], // CLAUDE.md / .claude/settings.json from the workspace
        includePartialMessages: true,
        abortController: run.controller,
        env: childEnv(),
      },
    });

    for await (const msg of stream) {
      for (const ev of mapMessage(msg, run)) {
        if (ev.type === "result") sawResult = true;
        yield ev;
      }
    }
    finishRun(run, sawResult ? "completed" : "error");
  } catch (err) {
    const aborted = run.controller.signal.aborted;
    if (sawResult && !aborted) {
      // The CLI can exit non-zero after it already delivered a result (e.g. auth errors); the result is what matters.
      finishRun(run, "completed");
      return;
    }
    finishRun(run, aborted ? "aborted" : "error");
    yield { type: "error", message: aborted ? "aborted" : err instanceof Error ? err.message : String(err) };
  }
}

function* mapMessage(msg: SDKMessage, run: Run): Generator<AgentEvent> {
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        run.sessionId = msg.session_id;
        yield { type: "init", run_id: run.runId, session_id: msg.session_id, model: msg.model, tools: msg.tools, cwd: msg.cwd };
      }
      return;

    case "stream_event": {
      // Only top-level text; subagent output has a parent_tool_use_id.
      const e = msg.event;
      if (msg.parent_tool_use_id === null && e.type === "content_block_delta" && e.delta.type === "text_delta") {
        yield { type: "text", text: e.delta.text };
      }
      return;
    }

    case "assistant":
      for (const block of msg.message.content) {
        if (block.type === "tool_use") yield { type: "tool_use", id: block.id, name: block.name, input: block.input };
      }
      return;

    case "user": {
      const content = msg.message.content;
      if (typeof content === "string") return;
      for (const block of content) {
        if (block.type === "tool_result") {
          yield {
            type: "tool_result",
            tool_use_id: block.tool_use_id,
            is_error: Boolean(block.is_error),
            content: truncate(stringifyToolContent(block.content)),
          };
        }
      }
      return;
    }

    case "result":
      yield {
        type: "result",
        session_id: msg.session_id,
        subtype: msg.subtype,
        is_error: msg.is_error,
        result: msg.subtype === "success" ? msg.result : null,
        errors: msg.subtype === "success" ? undefined : msg.errors,
        num_turns: msg.num_turns,
        duration_ms: msg.duration_ms,
        total_cost_usd: msg.total_cost_usd,
        usage: msg.usage,
        permission_denials: msg.permission_denials,
      };
      return;
  }
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : `[${(c as { type?: string })?.type ?? "content"}]`)).join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

function truncate(s: string): string {
  return s.length > TOOL_RESULT_MAX ? s.slice(0, TOOL_RESULT_MAX) + `… [${s.length - TOOL_RESULT_MAX} more chars]` : s;
}
