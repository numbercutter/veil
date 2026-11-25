import type { AuditLog } from "./audit";
import { mask, placeholders, Session, StreamUnmasker, unmask, type Masked } from "./mask";
import type { DetectOptions } from "./detect";

export type ProxyOptions = DetectOptions & {
  upstream?: string;
  anthropicUpstream?: string;
  log: AuditLog;
  port?: number;
  hostname?: string;
};

const OPENAI_HEADERS = ["authorization", "api-key", "x-api-key", "openai-organization", "openai-project"];
const ANTHROPIC_HEADERS = ["x-api-key", "authorization", "anthropic-version", "anthropic-beta"];

type Part = { type?: string; text?: string };
type ToolCall = { index?: number; function?: { arguments?: string } };
type Message = { content?: string | Part[] | null; tool_calls?: ToolCall[] };
type Block = { type?: string; text?: string; input?: unknown; content?: string | Block[] };

type SseEvent = { event?: string; data?: string; extra: string[] };

function error(status: number, message: string): Response {
  return Response.json({ error: { message, type: "veil_error" } }, { status });
}

function base(url: string) {
  return url.replace(/\/$/, "");
}

function headersFrom(request: Request, names: string[]): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of names) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function deep(value: unknown, apply: (text: string) => string): unknown {
  if (typeof value === "string") return apply(value);
  if (Array.isArray(value)) return value.map((item) => deep(item, apply));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item, apply)]));
  return value;
}

function parseSse(block: string): SseEvent {
  const event: SseEvent = { extra: [] };
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    else if (line.startsWith("event:")) event.event = line.slice(6).trim();
    else if (line) event.extra.push(line);
  }
  if (data.length) event.data = data.join("\n");
  return event;
}

function formatSse(event: SseEvent): string {
  const lines = [...(event.event ? [`event: ${event.event}`] : []), ...event.extra];
  if (event.data !== undefined) for (const line of event.data.split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

function transformSse(source: ReadableStream<Uint8Array>, handle: (event: SseEvent) => SseEvent[], finish: () => SseEvent[]): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          if (!block.trim()) continue;
          for (const out of handle(parseSse(block))) controller.enqueue(encoder.encode(formatSse(out)));
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.trim()) for (const out of handle(parseSse(buffer))) controller.enqueue(encoder.encode(formatSse(out)));
        for (const out of finish()) controller.enqueue(encoder.encode(formatSse(out)));
      },
    }),
  );
}

class Unmaskers {
  private readonly map = new Map<string, StreamUnmasker>();
  constructor(private readonly session: Session) {}

  get(key: string, json = false): StreamUnmasker {
    let unmasker = this.map.get(key);
    if (!unmasker) {
      unmasker = new StreamUnmasker(this.session, { json });
      this.map.set(key, unmasker);
    }
    return unmasker;
  }

  flush(prefix = ""): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const [key, unmasker] of this.map) {
      if (!key.startsWith(prefix)) continue;
      const rest = unmasker.flush();
      if (rest) out.push([key, rest]);
    }
    return out;
  }

  get restored(): string[] {
    return [...this.map.values()].flatMap((unmasker) => unmasker.restored);
  }
}

function auditRestored(log: AuditLog, session: Session, restored: string[], note: string) {
  const known = new Set(restored.filter((p) => session.lookup(p) !== undefined));
  log.append({
    kind: "restored",
    request: session.id,
    items: log.itemsFor(session.toJSON().entries.filter((e) => known.has(e.placeholder))),
    note,
  });
}

function streamHeaders(session: Session): Headers {
  return new Headers({ "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-veil-masked": String(session.size) });
}

function maskOpenAi(messages: Message[], apply: (text: string) => string) {
  for (const message of messages) {
    if (typeof message.content === "string") message.content = apply(message.content);
    else if (Array.isArray(message.content)) {
      for (const part of message.content) if (typeof part.text === "string") part.text = apply(part.text);
    }
    for (const call of message.tool_calls ?? []) {
      if (typeof call.function?.arguments === "string") call.function.arguments = apply(call.function.arguments);
    }
  }
}

function unmaskOpenAi(body: { choices?: Array<{ message?: Message }> }, session: Session): string[] {
  const restored: string[] = [];
  const apply = (text: string, json = false) => {
    restored.push(...placeholders(text));
    return unmask(text, session, { json });
  };
  for (const choice of body.choices ?? []) {
    const message = choice.message;
    if (!message) continue;
    if (typeof message.content === "string") message.content = apply(message.content);
    for (const call of message.tool_calls ?? []) {
      if (typeof call.function?.arguments === "string") call.function.arguments = apply(call.function.arguments, true);
    }
  }
  return restored;
}

function openAiStream(source: ReadableStream<Uint8Array>, session: Session, onDone: (restored: string[]) => void): ReadableStream<Uint8Array> {
  const unmaskers = new Unmaskers(session);
  let template: Record<string, unknown> = { object: "chat.completion.chunk" };
  let done = false;

  const leftovers = (prefix: string) => {
    const delta: { content?: string; tool_calls?: ToolCall[] } = {};
    for (const [key, rest] of unmaskers.flush(prefix)) {
      const [, field, tool] = key.split(":");
      if (field === "content") delta.content = rest;
      else (delta.tool_calls ??= []).push({ index: Number(tool), function: { arguments: rest } });
    }
    return delta;
  };

  const finish = (): SseEvent[] => {
    const out: SseEvent[] = [];
    const choices = new Map<number, { content?: string; tool_calls?: ToolCall[] }>();
    for (const [key, rest] of unmaskers.flush()) {
      const [index, field, tool] = key.split(":");
      const delta = choices.get(Number(index)) ?? {};
      if (field === "content") delta.content = rest;
      else (delta.tool_calls ??= []).push({ index: Number(tool), function: { arguments: rest } });
      choices.set(Number(index), delta);
    }
    if (choices.size) {
      out.push({ extra: [], data: JSON.stringify({ ...template, choices: [...choices].map(([index, delta]) => ({ index, delta, finish_reason: null })) }) });
    }
    if (!done) onDone(unmaskers.restored);
    done = true;
    return out;
  };

  return transformSse(
    source,
    (event) => {
      if (event.data === undefined) return [event];
      if (event.data.trim() === "[DONE]") return [...finish(), event];
      let chunk: any;
      try {
        chunk = JSON.parse(event.data);
      } catch {
        return [event];
      }
      const { choices: _choices, usage: _usage, ...rest } = chunk;
      template = { ...rest };
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta ?? {};
        const index = choice.index ?? 0;
        if (typeof delta.content === "string") delta.content = unmaskers.get(`${index}:content`).push(delta.content);
        for (const call of delta.tool_calls ?? []) {
          if (typeof call.function?.arguments === "string") {
            call.function.arguments = unmaskers.get(`${index}:tool:${call.index ?? 0}`, true).push(call.function.arguments);
          }
        }
        if (choice.finish_reason) {
          const tail = leftovers(`${index}:`);
          if (tail.content) delta.content = (delta.content ?? "") + tail.content;
          for (const call of tail.tool_calls ?? []) (delta.tool_calls ??= []).push(call);
          choice.delta = delta;
        }
      }
      return [{ ...event, data: JSON.stringify(chunk) }];
    },
    finish,
  );
}

function maskAnthropic(body: { system?: string | Block[]; messages: Array<{ content?: string | Block[] }> }, apply: (text: string) => string) {
  const blocks = (list: Block[]) => {
    for (const block of list) {
      if (typeof block.text === "string") block.text = apply(block.text);
      if (block.type === "tool_use" && block.input !== undefined) block.input = deep(block.input, apply);
      if (typeof block.content === "string") block.content = apply(block.content);
      else if (Array.isArray(block.content)) blocks(block.content);
    }
  };
  if (typeof body.system === "string") body.system = apply(body.system);
  else if (Array.isArray(body.system)) blocks(body.system);
  for (const message of body.messages) {
    if (typeof message.content === "string") message.content = apply(message.content);
    else if (Array.isArray(message.content)) blocks(message.content);
  }
}

function unmaskAnthropic(body: { content?: Block[] }, session: Session): string[] {
  const restored: string[] = [];
  const apply = (text: string) => {
    restored.push(...placeholders(text));
    return unmask(text, session);
  };
  for (const block of body.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") block.text = apply(block.text);
    if (block.type === "tool_use" && block.input !== undefined) block.input = deep(block.input, apply);
  }
  return restored;
}

function anthropicStream(source: ReadableStream<Uint8Array>, session: Session, onDone: (restored: string[]) => void): ReadableStream<Uint8Array> {
  const unmaskers = new Unmaskers(session);
  const kinds = new Map<number, "text_delta" | "input_json_delta">();
  let done = false;
  const tail = (index: number): SseEvent[] => {
    const kind = kinds.get(index);
    const rest = unmaskers.flush(`${index}:`).map(([, text]) => text).join("");
    if (!rest || !kind) return [];
    const delta = kind === "text_delta" ? { type: kind, text: rest } : { type: kind, partial_json: rest };
    return [{ event: "content_block_delta", extra: [], data: JSON.stringify({ type: "content_block_delta", index, delta }) }];
  };
  const finish = (): SseEvent[] => {
    const out = [...kinds.keys()].flatMap(tail);
    if (!done) onDone(unmaskers.restored);
    done = true;
    return out;
  };
  return transformSse(
    source,
    (event) => {
      if (event.data === undefined) return [event];
      let data: any;
      try {
        data = JSON.parse(event.data);
      } catch {
        return [event];
      }
      if (data.type === "content_block_start" && data.content_block) {
        const block = data.content_block;
        if (block.type === "text" && typeof block.text === "string") block.text = unmaskers.get(`${data.index}:text`).push(block.text);
        if (block.type === "tool_use" && block.input !== undefined) block.input = deep(block.input, (text) => unmask(text, session));
      }
      if (data.type === "content_block_delta" && data.delta) {
        const delta = data.delta;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          kinds.set(data.index, "text_delta");
          delta.text = unmaskers.get(`${data.index}:text`).push(delta.text);
        }
        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          kinds.set(data.index, "input_json_delta");
          delta.partial_json = unmaskers.get(`${data.index}:json`, true).push(delta.partial_json);
        }
      }
      const out: SseEvent = { ...event, data: JSON.stringify(data) };
      if (data.type === "content_block_stop") return [...tail(data.index), out];
      if (data.type === "message_stop") return [...finish(), out];
      return [out];
    },
    finish,
  );
}

type Handler = {
  route: string;
  target: string;
  headers: string[];
  validate: (body: any) => string | null;
  maskBody: (body: any, apply: (text: string) => string) => void;
  unmaskBody: (body: any, session: Session) => string[];
  stream: (source: ReadableStream<Uint8Array>, session: Session, onDone: (restored: string[]) => void) => ReadableStream<Uint8Array>;
};

function handle(handler: Handler, log: AuditLog, detectOptions: DetectOptions) {
  return async (request: Request): Promise<Response> => {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return error(400, "request body must be JSON");
    }
    const invalid = handler.validate(body);
    if (invalid) return error(400, invalid);

    const session = new Session();
    const found: Masked[] = [];
    handler.maskBody(body, (text) => {
      const result = mask(text, { ...detectOptions, session });
      found.push(...result.found);
      return result.text;
    });
    log.append({ kind: "masked", request: session.id, items: log.itemsFor(found), note: handler.route });

    let upstream: Response;
    try {
      upstream = await fetch(handler.target, { method: "POST", headers: headersFrom(request, handler.headers), body: JSON.stringify(body) });
    } catch (cause) {
      log.append({ kind: "upstream_error", request: session.id, items: [], note: "unreachable" });
      return error(502, `upstream unreachable: ${(cause as Error).message}`);
    }

    if (body.stream && upstream.ok && upstream.body && (upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const stream = handler.stream(upstream.body, session, (restored) => auditRestored(log, session, restored, `status ${upstream.status}, stream`));
      return new Response(stream, { status: upstream.status, headers: streamHeaders(session) });
    }

    const text = await upstream.text();
    let reply: any;
    try {
      reply = JSON.parse(text);
    } catch {
      log.append({ kind: "upstream_error", request: session.id, items: [], note: `status ${upstream.status}, not JSON` });
      return error(502, `upstream answered ${upstream.status} with a non-JSON body`);
    }
    auditRestored(log, session, handler.unmaskBody(reply, session), `status ${upstream.status}`);
    return Response.json(reply, { status: upstream.status, headers: { "x-veil-masked": String(session.size) } });
  };
}

export function serveProxy(options: ProxyOptions) {
  const { log } = options;
  const detectOptions: DetectOptions = { names: options.names, terms: options.terms };
  const routes: Record<string, { POST: (request: Request) => Promise<Response> }> = {};

  if (options.upstream) {
    routes["/v1/chat/completions"] = {
      POST: handle(
        {
          route: "/v1/chat/completions",
          target: `${base(options.upstream)}/chat/completions`,
          headers: OPENAI_HEADERS,
          validate: (body) => (Array.isArray(body?.messages) ? null : "messages must be an array"),
          maskBody: (body, apply) => maskOpenAi(body.messages, apply),
          unmaskBody: unmaskOpenAi,
          stream: openAiStream,
        },
        log,
        detectOptions,
      ),
    };
  }
  if (options.anthropicUpstream) {
    routes["/v1/messages"] = {
      POST: handle(
        {
          route: "/v1/messages",
          target: `${base(options.anthropicUpstream)}/messages`,
          headers: ANTHROPIC_HEADERS,
          validate: (body) => (Array.isArray(body?.messages) ? null : "messages must be an array"),
          maskBody: maskAnthropic,
          unmaskBody: unmaskAnthropic,
          stream: anthropicStream,
        },
        log,
        detectOptions,
      ),
    };
  }
  const served = Object.keys(routes).join(" and ");

  return Bun.serve({
    port: options.port ?? 8787,
    hostname: options.hostname ?? "127.0.0.1",
    routes: {
      "/health": () => Response.json({ ok: true, upstream: options.upstream ?? null, anthropicUpstream: options.anthropicUpstream ?? null }),
      ...routes,
    },
    fetch: () => error(404, `veil proxies POST ${served || "nothing: no upstream is set"}`),
  });
}
