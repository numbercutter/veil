import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, serveProxy, verifyLog } from "../src";
import { startMockUpstream } from "./mock-upstream";

const dir = mkdtempSync(join(tmpdir(), "veil-stream-"));
const logPath = join(dir, "audit.jsonl");
const upstream = startMockUpstream(0, { chunkChars: 3, byteSplit: 7 });
const proxy = serveProxy({
  upstream: `${upstream.server.url}v1`,
  anthropicUpstream: `${upstream.server.url}v1`,
  log: new AuditLog(logPath, "example-audit-key"),
  port: 0,
  names: ["Maria Okafor"],
});

const message = "Write to Maria Okafor at maria.okafor@example.com, DOB 04/07/1986, 1600 Pennsylvania Ave NW Apt 4, NINO AB 12 34 56 C.";
const raw = ["maria", "04/07/1986", "1600 pennsylvania", "ab 12 34 56 c"];

async function readSse(response: Response) {
  const events: string[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body!) {
    buffer += decoder.decode(chunk, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop()!;
    events.push(...blocks.filter(Boolean));
  }
  return events.map((block) => block.split("\n").find((line) => line.startsWith("data: "))!.slice(6));
}

function rawLeaks() {
  const wire = JSON.stringify(upstream.seen.map((s) => s.body)).toLowerCase();
  return raw.filter((value) => wire.includes(value)).length;
}

console.log("app sends:\n ", message);

console.log("\n1. OpenAI chat completions, stream: true, with a tool");
const openai = await fetch(`${proxy.url}v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer sk-not-a-real-key" },
  body: JSON.stringify({ model: "m", stream: true, tools: [{ type: "function", function: { name: "send_email" } }], messages: [{ role: "user", content: message }] }),
});
const chunks = (await readSse(openai)).filter((data) => data !== "[DONE]").map((data) => JSON.parse(data));
const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
const args = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []).map((t: any) => t.function?.arguments ?? "").join("");
const upstreamText = `Noted. I will follow up with ${upstream.seen[0].body.messages[0].content}`;
const split = [...upstreamText.matchAll(/⟦[A-Z]+_\d+⟧/g)].filter((m) => Math.floor(m.index! / 3) !== Math.floor((m.index! + m[0].length - 1) / 3)).length;
console.log(`  upstream saw:   ${upstream.seen[0].body.messages[0].content}`);
console.log(`  upstream streamed ${chunks.length} chunks of 3 characters, in 7-byte network writes; ${split} placeholders were cut across chunks`);
console.log(`  app read:       ${text}`);
console.log(`  tool arguments: ${args}  (parses: ${JSON.parse(args).to})`);
console.log(`  restored exactly: ${text === `Noted. I will follow up with ${message}`}`);

console.log("\n2. Anthropic messages, non-streaming");
const plain = await fetch(`${proxy.url}v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": "not-a-real-key", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({ model: "m", max_tokens: 200, system: "Customer: Maria Okafor", messages: [{ role: "user", content: [{ type: "text", text: message }] }] }),
});
const plainBody = (await plain.json()) as any;
console.log(`  upstream saw system: ${upstream.seen[1].body.system}`);
console.log(`  headers passed: x-api-key ${upstream.seen[1].headers["x-api-key"]}, anthropic-version ${upstream.seen[1].headers["anthropic-version"]}`);
console.log(`  app read:     ${plainBody.content[0].text}`);

console.log("\n3. Anthropic messages, stream: true");
const streamed = await fetch(`${proxy.url}v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": "not-a-real-key", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({ model: "m", max_tokens: 200, stream: true, messages: [{ role: "user", content: message }] }),
});
const events = (await readSse(streamed)).map((data) => JSON.parse(data));
const streamedText = events.filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join("");
console.log(`  ${events.length} events, last ${events.at(-1).type}`);
console.log(`  app read:     ${streamedText}`);
console.log(`  restored exactly: ${streamedText === `Understood. Replying to ${message}`}`);

console.log(`\nraw values in upstream traffic: ${rawLeaks()}`);
const log = readFileSync(logPath, "utf8").toLowerCase();
console.log(`raw values in audit log:        ${raw.filter((value) => log.includes(value)).length}`);
const report = verifyLog(logPath);
console.log(`verify-log: ${report.ok ? `ok, ${report.entries} entries` : report.reason}`);

proxy.stop(true);
upstream.server.stop(true);
rmSync(dir, { recursive: true, force: true });
