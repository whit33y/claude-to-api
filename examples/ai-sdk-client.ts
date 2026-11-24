// Talks to the container through the Vercel AI SDK's own transport (the same one useChat uses).
// Run: API_TOKEN=... npx tsx examples/ai-sdk-client.ts
import { DefaultChatTransport, readUIMessageStream, type UIMessage } from "ai";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const transport = new DefaultChatTransport<UIMessage>({
  api: `${BASE}/v1/ai-sdk/chat`,
  headers: { Authorization: `Bearer ${process.env.API_TOKEN}` },
  // Optional agent options, merged into every request body:
  body: { allowed_tools: ["Read", "Grep", "Glob"] },
});

const chatId = `demo-${Date.now()}`;
const messages: UIMessage[] = [];

async function send(text: string) {
  messages.push({ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] });
  console.log(`\n> ${text}`);
  const stream = await transport.sendMessages({
    trigger: "submit-message",
    chatId,
    messageId: undefined,
    messages,
    abortSignal: undefined,
  });
  let last: UIMessage | undefined;
  for await (const msg of readUIMessageStream<UIMessage>({ stream, onError: (e) => console.error("[stream error]", e) })) {
    last = msg; // each iteration is the assistant message so far
  }
  if (!last) return;
  messages.push(last);
  for (const part of last.parts) {
    if (part.type === "text") console.log(part.text);
    else if (part.type === "dynamic-tool") console.log(`[tool ${part.toolName}] ${part.state}`);
  }
  console.log("[metadata]", JSON.stringify(last.metadata));
}

await send("Remember the word: mango. Reply in one sentence.");
await send("Which word did I ask you to remember? Then list the files in your working directory.");
