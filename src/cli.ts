#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { join } from "node:path";
import { mask } from "./mask";
import { AuditLog, loadAuditKey, verifyLog } from "./audit";
import { serveProxy } from "./proxy";

const usage = `veil: mask personal data before it reaches a model

usage:
  veil mask [TEXT] [--names A,B] [--terms X,Y] [--json]   reads stdin when TEXT is omitted
  veil serve [--upstream URL] [--port 8787] [--host 127.0.0.1] [--names A,B] [--terms X,Y]
  veil verify-log [PATH]

options:
  --dir PATH   data directory for audit.key and audit.jsonl (default $VEIL_DIR or .veil)
  --log PATH   audit log path (default <dir>/audit.jsonl)

env:
  VEIL_UPSTREAM   OpenAI-compatible base URL including /v1, e.g. https://api.openai.com/v1
  VEIL_AUDIT_KEY  key for hashing values in the audit log (default <dir>/audit.key)`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    dir: { type: "string" },
    log: { type: "string" },
    upstream: { type: "string" },
    port: { type: "string" },
    host: { type: "string" },
    names: { type: "string" },
    terms: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, arg] = positionals;
const dir = values.dir ?? process.env.VEIL_DIR ?? ".veil";
const logPath = values.log ?? join(dir, "audit.jsonl");
const list = (text?: string) => (text ? text.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

function fail(message: string): never {
  console.error(`veil: ${message}`);
  process.exit(1);
}

if (!command || values.help) {
  console.log(usage);
  process.exit(command ? 0 : 1);
}

switch (command) {
  case "mask": {
    const text = arg ?? (await Bun.stdin.text());
    const result = mask(text, { names: list(values.names), terms: list(values.terms) });
    if (values.json) console.log(JSON.stringify({ text: result.text, vault: result.session.toJSON() }, null, 2));
    else process.stdout.write(result.text.endsWith("\n") ? result.text : `${result.text}\n`);
    break;
  }
  case "serve": {
    const upstream = values.upstream ?? process.env.VEIL_UPSTREAM ?? fail("set --upstream or VEIL_UPSTREAM");
    const log = new AuditLog(logPath, loadAuditKey(dir));
    const server = serveProxy({
      upstream,
      log,
      port: values.port ? Number(values.port) : undefined,
      hostname: values.host,
      names: list(values.names),
      terms: list(values.terms),
    });
    console.log(`veil on ${server.url}v1/chat/completions -> ${upstream}`);
    console.log(`audit log ${logPath}`);
    break;
  }
  case "verify-log": {
    const path = arg ?? logPath;
    const report = verifyLog(path);
    if (report.ok) {
      console.log(`ok: ${report.entries} entries, chain intact`);
      console.log(`head ${report.head}`);
    } else {
      fail(`${path} line ${report.line}: ${report.reason} (${report.entries} entries verified before it)`);
    }
    break;
  }
  default:
    fail(`unknown command "${command}"\n\n${usage}`);
}
