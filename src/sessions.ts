import { randomUUID } from "node:crypto";

export type RunStatus = "running" | "completed" | "error" | "aborted";

export interface Run {
  runId: string;
  sessionId?: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  promptPreview: string;
  controller: AbortController;
}

const runs = new Map<string, Run>();
const HISTORY_LIMIT = 200;

export function activeCount(): number {
  let n = 0;
  for (const r of runs.values()) if (r.status === "running") n++;
  return n;
}

export function isSessionBusy(sessionId: string): boolean {
  for (const r of runs.values()) if (r.sessionId === sessionId && r.status === "running") return true;
  return false;
}

export function startRun(prompt: string, sessionId?: string): Run {
  const run: Run = {
    runId: randomUUID(),
    sessionId,
    status: "running",
    startedAt: new Date().toISOString(),
    promptPreview: prompt.slice(0, 80),
    controller: new AbortController(),
  };
  runs.set(run.runId, run);
  prune();
  return run;
}

export function finishRun(run: Run, status: RunStatus): void {
  if (run.status !== "running") return;
  run.status = status;
  run.finishedAt = new Date().toISOString();
}

/** Abort by run id or session id. Returns true when a running run was found. */
export function abort(id: string): boolean {
  for (const r of runs.values()) {
    if ((r.runId === id || r.sessionId === id) && r.status === "running") {
      r.controller.abort();
      finishRun(r, "aborted");
      return true;
    }
  }
  return false;
}

export function list() {
  return [...runs.values()]
    .reverse()
    .map(({ controller: _c, ...rest }) => rest);
}

function prune(): void {
  if (runs.size <= HISTORY_LIMIT) return;
  for (const [id, r] of runs) {
    if (r.status !== "running") runs.delete(id);
    if (runs.size <= HISTORY_LIMIT) break;
  }
}
