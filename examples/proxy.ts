import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, serveProxy, verifyLog } from "../src";
import { startMockUpstream } from "./mock-upstream";

const dir = mkdtempSync(join(tmpdir(), "veil-example-"));
const logPath = join(dir, "audit.jsonl");
const upstream = startMockUpstream(0);
const proxy = serveProxy({
  upstream: `${upstream.server.url}v1`,
  log: new AuditLog(logPath, "example-audit-key"),
  port: 0,
  names: ["Maria Okafor"],
});

const message =
  "Refund Maria Okafor (maria.okafor@example.com, +1 415 555 0132). " +
  "Card 4242 4242 4242 4242, SSN 123-45-6789, IBAN DE89 3704 0044 0532 0130 00, last login from 203.0.113.42.";

const response = await fetch(`${proxy.url}v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer sk-not-a-real-key" },
  body: JSON.stringify({ model: "any-model", messages: [{ role: "user", content: message }] }),
});
const reply = (await response.json()) as any;

console.log("app sent:\n ", message);
console.log("\nupstream saw:\n ", upstream.seen[0].body.messages[0].content);
console.log("  auth header passed through:", upstream.seen[0].headers.authorization);
console.log("\napp got back:\n ", reply.choices[0].message.content);
console.log(`\nraw values in upstream traffic: ${["maria", "4242 4242", "123-45-6789", "203.0.113"].filter((v) => JSON.stringify(upstream.seen).toLowerCase().includes(v)).length}`);

const log = readFileSync(logPath, "utf8");
console.log(`raw values in audit log:        ${["maria", "4242 4242", "123-45-6789", "203.0.113"].filter((v) => log.toLowerCase().includes(v)).length}`);
console.log("\naudit log line 1:\n ", log.split("\n")[0].slice(0, 220) + "...");

const intact = verifyLog(logPath);
console.log(`\nverify-log: ${intact.ok ? `ok, ${intact.entries} entries` : intact.reason}`);

const tampered = join(dir, "tampered.jsonl");
copyFileSync(logPath, tampered);
writeFileSync(tampered, readFileSync(tampered, "utf8").replace('"type":"CARD"', '"type":"IP"'));
const broken = verifyLog(tampered);
console.log(`verify-log after editing one field: ${broken.ok ? "ok (unexpected)" : `line ${broken.line}: ${broken.reason}`}`);

proxy.stop(true);
upstream.server.stop(true);
rmSync(dir, { recursive: true, force: true });
