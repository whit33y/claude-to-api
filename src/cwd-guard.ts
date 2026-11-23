import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { CWD_GUARDED_TOOLS } from "./policy.js";
import type { HookCallbackMatcher, PreToolUseHookInput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

/** Tool-input fields that name a file or directory (Read/Write/Edit, NotebookEdit, Grep/Glob). */
const PATH_FIELDS = ["file_path", "notebook_path", "path"];
/** Tool-input fields holding a glob pattern (Glob `pattern`, Grep `glob`). */
const GLOB_FIELDS: Record<string, string[]> = { Glob: ["pattern"], Grep: ["glob"] };

/**
 * A PreToolUse hook that denies any tool call whose path lies outside `cwd`.
 *
 * A hook rather than `canUseTool`: tools in `allowedTools` are pre-approved and never reach
 * `canUseTool`, but PreToolUse hooks run for every call (subagents included), and a hook's
 * "deny" wins over allow rules. `onFailure: "block"` makes a crashing hook fail closed.
 * Not covered: Grep/Glob walking into a symlinked directory inside cwd (callers should delete
 * symlinks from untrusted trees), and links swapped between this check and the tool's open.
 */
export function cwdGuard(cwd: string): HookCallbackMatcher {
  let root: Promise<string> | undefined; // resolved lazily so a missing cwd fails the hook (closed), not the process
  return {
    onFailure: "block",
    hooks: [
      async (input) => {
        const { tool_name, tool_input } = input as PreToolUseHookInput;
        const reason = await violation(tool_name, tool_input, cwd, await (root ??= realpath(cwd)));
        if (!reason) return {};
        const out: SyncHookJSONOutput = {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `${reason} (restrict_to_cwd: only paths inside the working directory are allowed)`,
          },
        };
        return out;
      },
    ],
  };
}

async function violation(tool: string, input: unknown, cwd: string, root: string): Promise<string | undefined> {
  if (!CWD_GUARDED_TOOLS.includes(tool)) return `${tool} is not allowed`;
  if (!input || typeof input !== "object") return undefined;
  const fields = input as Record<string, unknown>;

  for (const key of PATH_FIELDS) {
    const value = fields[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") return `${tool}.${key} is not a string`;
    if (!(await isInside(value, cwd, root))) return `${tool}: path "${value}" is outside the working directory`;
  }

  for (const key of GLOB_FIELDS[tool] ?? []) {
    const value = fields[key];
    if (typeof value !== "string") continue;
    if (escapesViaGlob(value)) return `${tool}: pattern "${value}" may reach outside the working directory`;
  }
  return undefined;
}

/** Resolve `p` against cwd, follow symlinks as far as the path exists, and check it stays under root. */
async function isInside(p: string, cwd: string, root: string): Promise<boolean> {
  if (p.includes("\0") || p.startsWith("~")) return false;
  const real = await realpathLenient(path.resolve(cwd, p));
  return real !== undefined && (real === root || real.startsWith(root + path.sep));
}

/**
 * realpath of the deepest existing ancestor, with the not-yet-existing tail appended.
 * undefined if a component exists but can't be resolved (e.g. a dangling symlink, which Write would follow).
 */
async function realpathLenient(abs: string): Promise<string | undefined> {
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(head), ...tail);
    } catch {
      if (await lstat(head).then(() => true, () => false)) return undefined;
      const parent = path.dirname(head);
      if (parent === head) return undefined;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

function escapesViaGlob(pattern: string): boolean {
  // Also catches brace alternatives such as "{/proc,x}/*" or "{..,a}/**".
  return pattern.includes("..") || /(^|[{,])\s*[/~\\]/.test(pattern);
}
