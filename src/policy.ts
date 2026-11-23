import path from "node:path";
import { z } from "zod";
import type { EffortLevel, PermissionMode, SettingSource } from "@anthropic-ai/claude-agent-sdk";

/** Effort levels, lowest to highest. */
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly EffortLevel[];
const Effort = z.enum(EFFORT_LEVELS);

/** Server-side configuration, read once from the environment. */
export const config = {
  port: Number(process.env.PORT ?? 8787),
  apiToken: process.env.API_TOKEN ?? "",
  workspaceDir: path.resolve(process.env.WORKSPACE_DIR ?? "/workspace"),
  defaultModel: process.env.DEFAULT_MODEL || undefined,
  /** Effort used when a request doesn't pass one; undefined = the model's default. */
  defaultEffort: envEffort("DEFAULT_EFFORT"),
  /** Ceiling: the highest effort any request may ask for; undefined = no limit. */
  maxEffort: envEffort("MAX_EFFORT"),
  /** Ceiling: the most tools any request may enable. */
  maxAllowedTools: csv(process.env.MAX_ALLOWED_TOOLS ?? "Read,Grep,Glob,Edit,Write,Bash,WebFetch,WebSearch"),
  /** Used when a request does not name any tools. */
  defaultTools: csv(process.env.DEFAULT_TOOLS ?? "Read,Grep,Glob"),
  allowBypass: process.env.ALLOW_BYPASS === "true",
  maxConcurrentRuns: Number(process.env.MAX_CONCURRENT_RUNS ?? 2),
  maxTurnsCeiling: Number(process.env.MAX_TURNS_CEILING ?? 50),
  /** Browser origins allowed to call the API (CORS). Empty = no CORS headers. */
  corsOrigins: csv(process.env.CORS_ORIGINS ?? ""),
};

function envEffort(name: string): EffortLevel | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Effort.safeParse(value);
  if (!parsed.success) throw new Error(`${name} must be one of ${EFFORT_LEVELS.join(", ")} (got "${value}").`);
  return parsed.data;
}

function csv(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export const QueryRequest = z.object({
  prompt: z.string().min(1).max(200_000),
  session_id: z.string().uuid().optional(),
  allowed_tools: z.array(z.string().min(1)).max(50).optional(),
  permission_mode: z.enum(["default", "dontAsk", "acceptEdits", "plan", "bypassPermissions"]).optional(),
  cwd: z.string().max(500).optional(),
  model: z.string().max(100).optional(),
  effort: Effort.optional(),
  system_prompt_append: z.string().max(50_000).optional(),
  max_turns: z.number().int().min(1).optional(),
  /** Which settings files the agent loads; send [] for untrusted code so no workspace hooks/MCP servers load. */
  setting_sources: z.array(z.enum(["user", "project", "local"])).max(3).optional(),
  /** Deny file tools any path outside the resolved cwd (for untrusted code, e.g. PR snapshots). */
  restrict_to_cwd: z.boolean().optional(),
});
export type QueryRequest = z.infer<typeof QueryRequest>;

export class PolicyError extends Error {}

export interface ResolvedRun {
  prompt: string;
  resume?: string;
  tools: string[];
  permissionMode: PermissionMode;
  cwd: string;
  model?: string;
  effort?: EffortLevel;
  systemPromptAppend?: string;
  maxTurns: number;
  settingSources: SettingSource[];
  restrictToCwd: boolean;
}

/** The only tools whose path arguments the cwd guard understands; everything else is refused with restrict_to_cwd. */
export const CWD_GUARDED_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "NotebookEdit"];

/** Validate a request against the server's limits and turn it into SDK-ready settings. */
export function resolveRun(req: QueryRequest): ResolvedRun {
  const tools = req.allowed_tools ?? config.defaultTools;
  const outside = tools.filter((t) => !config.maxAllowedTools.includes(t));
  if (outside.length) {
    throw new PolicyError(`Tools not permitted on this server: ${outside.join(", ")}. Allowed: ${config.maxAllowedTools.join(", ")}`);
  }

  // Headless: nobody can answer a permission prompt, so "default" means "deny anything not pre-approved".
  const mode: PermissionMode = req.permission_mode === "default" || !req.permission_mode ? "dontAsk" : req.permission_mode;
  if (mode === "bypassPermissions" && !config.allowBypass) {
    throw new PolicyError("permission_mode 'bypassPermissions' is disabled (set ALLOW_BYPASS=true to enable).");
  }

  const cwd = path.resolve(config.workspaceDir, req.cwd ?? ".");
  if (cwd !== config.workspaceDir && !cwd.startsWith(config.workspaceDir + path.sep)) {
    throw new PolicyError("cwd must stay inside the workspace.");
  }

  // restrict_to_cwd: only path-checkable tools, and no settings from inside the (untrusted) cwd,
  // since project/local settings can define hooks and MCP servers that run outside any tool check.
  let settingSources: SettingSource[] = req.setting_sources ?? (req.restrict_to_cwd ? [] : ["project"]);
  if (req.restrict_to_cwd) {
    const unsafe = tools.filter((t) => !CWD_GUARDED_TOOLS.includes(t));
    if (unsafe.length) {
      throw new PolicyError(`restrict_to_cwd only works with ${CWD_GUARDED_TOOLS.join(", ")}; not with: ${unsafe.join(", ")}.`);
    }
    if (settingSources.some((s) => s !== "user")) {
      throw new PolicyError("restrict_to_cwd cannot load 'project' or 'local' settings (they come from the untrusted cwd).");
    }
  }
  settingSources = [...new Set(settingSources)];

  const effort = req.effort ?? config.defaultEffort;
  if (effort && config.maxEffort && EFFORT_LEVELS.indexOf(effort) > EFFORT_LEVELS.indexOf(config.maxEffort)) {
    throw new PolicyError(`effort '${effort}' is above this server's limit '${config.maxEffort}'.`);
  }

  return {
    prompt: req.prompt,
    resume: req.session_id,
    tools,
    permissionMode: mode,
    cwd,
    model: req.model ?? config.defaultModel,
    effort,
    systemPromptAppend: req.system_prompt_append,
    maxTurns: Math.min(req.max_turns ?? 20, config.maxTurnsCeiling),
    settingSources,
    restrictToCwd: req.restrict_to_cwd ?? false,
  };
}

/** Env for the Claude subprocess: inherit the container env minus this server's own secret. */
export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "API_TOKEN") env[k] = v;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "claude-docker/0.1.0";
  return env;
}
