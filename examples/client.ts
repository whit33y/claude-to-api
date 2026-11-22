// Minimal streaming client. Run: API_TOKEN=... npx tsx examples/client.ts "your prompt" [session_id]
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const [prompt = "Hello!", sessionId] = process.argv.slice(2);

const res = await fetch(`${BASE}/v1/query?stream=1`, {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.API_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ prompt, session_id: sessionId, allowed_tools: ["Read", "Grep", "Glob"] }),
});
if (!res.ok || !res.body) throw new Error(`${res.status}: ${await res.text()}`);

const decoder = new TextDecoder();
let buf = "";
for await (const chunk of res.body) {
  buf += decoder.decode(chunk, { stream: true });
  let i: number;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const frame = buf.slice(0, i);
    buf = buf.slice(i + 2);
    const data = frame.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
    if (!data) continue;
    const ev = JSON.parse(data);
    if (ev.type === "text") process.stdout.write(ev.text);
    else if (ev.type === "tool_use") console.log(`\n[tool] ${ev.name} ${JSON.stringify(ev.input)}`);
    else if (ev.type === "result") console.log(`\n\n[done] session=${ev.session_id} turns=${ev.num_turns} cost=$${ev.total_cost_usd}`);
    else if (ev.type === "error") console.error(`\n[error] ${ev.message}`);
  }
}
