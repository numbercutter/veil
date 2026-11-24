import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import type { Masked } from "./mask";

export type AuditItem = { type: string; placeholder: string; hash: string };

export type AuditEvent = { kind: string; request: string; items: AuditItem[]; note?: string };

export type AuditEntry = AuditEvent & { seq: number; ts: string; prev: string; hash: string };

export type VerifyReport =
  | { ok: true; entries: number; head: string }
  | { ok: false; entries: number; line: number; reason: string };

const GENESIS = "0".repeat(64);

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function digest(entry: Omit<AuditEntry, "hash">): string {
  const { seq, ts, kind, request, items, note, prev } = entry;
  return sha256(JSON.stringify({ seq, ts, kind, request, items: items.map(({ type, placeholder, hash }) => ({ type, placeholder, hash })), note: note ?? null, prev }));
}

export function loadAuditKey(dir: string): string {
  if (process.env.VEIL_AUDIT_KEY) return process.env.VEIL_AUDIT_KEY;
  const file = join(dir, "audit.key");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(dir, { recursive: true });
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  return key;
}

export class AuditLog {
  readonly path: string;
  private readonly key: string;
  private seq = 0;
  private prev = GENESIS;

  constructor(path: string, key: string) {
    this.path = path;
    this.key = key;
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
      const last = lines.at(-1);
      if (last) {
        const entry = JSON.parse(last) as AuditEntry;
        this.seq = entry.seq;
        this.prev = entry.hash;
      }
    }
  }

  itemsFor(found: Masked[]): AuditItem[] {
    const seen = new Set<string>();
    const items: AuditItem[] = [];
    for (const entry of found) {
      if (seen.has(entry.placeholder)) continue;
      seen.add(entry.placeholder);
      const hash = createHmac("sha256", this.key).update(`${entry.type}:${entry.normalized}`).digest("hex");
      items.push({ type: entry.type, placeholder: entry.placeholder, hash });
    }
    return items;
  }

  append(event: AuditEvent): AuditEntry {
    const base = { seq: this.seq + 1, ts: new Date().toISOString(), kind: event.kind, request: event.request, items: event.items, note: event.note, prev: this.prev };
    const entry: AuditEntry = { ...base, hash: digest(base) };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    this.seq = entry.seq;
    this.prev = entry.hash;
    return entry;
  }
}

export function verifyLog(path: string): VerifyReport {
  if (!existsSync(path)) return { ok: false, entries: 0, line: 0, reason: `no log at ${path}` };
  const lines = readFileSync(path, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let entry: AuditEntry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      return { ok: false, entries: i, line: i + 1, reason: "not valid JSON" };
    }
    if (entry.seq !== i + 1) return { ok: false, entries: i, line: i + 1, reason: `expected seq ${i + 1}, found ${entry.seq}` };
    if (entry.prev !== prev) return { ok: false, entries: i, line: i + 1, reason: "prev does not match the line before" };
    if (digest(entry) !== entry.hash) return { ok: false, entries: i, line: i + 1, reason: "content does not match its hash" };
    prev = entry.hash;
  }
  return { ok: true, entries: lines.length, head: prev };
}
