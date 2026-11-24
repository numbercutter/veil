import type { AuditLog } from "./audit";
import { mask, placeholders, Session, unmask, type Masked } from "./mask";
import type { DetectOptions } from "./detect";

export type ProxyOptions = DetectOptions & {
  upstream: string;
  log: AuditLog;
  port?: number;
  hostname?: string;
};

const FORWARD_HEADERS = ["authorization", "api-key", "x-api-key", "openai-organization", "openai-project"];

type Part = { type?: string; text?: string };
type ToolCall = { function?: { arguments?: string } };
type Message = { content?: string | Part[] | null; tool_calls?: ToolCall[] };

function error(status: number, message: string): Response {
  return Response.json({ error: { message, type: "veil_error" } }, { status });
}

function maskMessages(messages: Message[], session: Session, options: DetectOptions): Masked[] {
  const found: Masked[] = [];
  const apply = (text: string) => {
    const result = mask(text, { ...options, session });
    found.push(...result.found);
    return result.text;
  };
  for (const message of messages) {
    if (typeof message.content === "string") message.content = apply(message.content);
    else if (Array.isArray(message.content)) {
      for (const part of message.content) if (typeof part.text === "string") part.text = apply(part.text);
    }
    for (const call of message.tool_calls ?? []) {
      if (typeof call.function?.arguments === "string") call.function.arguments = apply(call.function.arguments);
    }
  }
  return found;
}

function unmaskChoices(body: { choices?: Array<{ message?: Message }> }, session: Session): string[] {
  const restored: string[] = [];
  const apply = (text: string) => {
    restored.push(...placeholders(text));
    return unmask(text, session);
  };
  for (const choice of body.choices ?? []) {
    const message = choice.message;
    if (!message) continue;
    if (typeof message.content === "string") message.content = apply(message.content);
    for (const call of message.tool_calls ?? []) {
      if (typeof call.function?.arguments === "string") call.function.arguments = apply(call.function.arguments);
    }
  }
  return restored;
}

export function serveProxy(options: ProxyOptions) {
  const { log } = options;
  const target = `${options.upstream.replace(/\/$/, "")}/chat/completions`;
  const detectOptions: DetectOptions = { names: options.names, terms: options.terms };

  return Bun.serve({
    port: options.port ?? 8787,
    hostname: options.hostname ?? "127.0.0.1",
    routes: {
      "/health": () => Response.json({ ok: true, upstream: options.upstream }),
      "/v1/chat/completions": {
        POST: async (request) => {
          let body: { stream?: boolean; messages?: Message[] };
          try {
            body = await request.json();
          } catch {
            return error(400, "request body must be JSON");
          }
          if (body.stream) return error(400, "veil does not proxy streaming responses yet; send stream: false");
          if (!Array.isArray(body.messages)) return error(400, "messages must be an array");

          const session = new Session();
          const found = maskMessages(body.messages, session, detectOptions);
          log.append({ kind: "masked", request: session.id, items: log.itemsFor(found) });

          const headers = new Headers({ "content-type": "application/json" });
          for (const name of FORWARD_HEADERS) {
            const value = request.headers.get(name);
            if (value) headers.set(name, value);
          }

          let upstream: Response;
          try {
            upstream = await fetch(target, { method: "POST", headers, body: JSON.stringify(body) });
          } catch (cause) {
            log.append({ kind: "upstream_error", request: session.id, items: [], note: "unreachable" });
            return error(502, `upstream unreachable: ${(cause as Error).message}`);
          }

          const text = await upstream.text();
          let reply: { choices?: Array<{ message?: Message }> };
          try {
            reply = JSON.parse(text);
          } catch {
            log.append({ kind: "upstream_error", request: session.id, items: [], note: `status ${upstream.status}, not JSON` });
            return error(502, `upstream answered ${upstream.status} with a non-JSON body`);
          }
          const restored = unmaskChoices(reply, session);
          const known = restored.filter((p) => session.lookup(p) !== undefined);
          log.append({
            kind: "restored",
            request: session.id,
            items: log.itemsFor(session.toJSON().entries.filter((e) => known.includes(e.placeholder))),
            note: `status ${upstream.status}`,
          });
          return Response.json(reply, { status: upstream.status, headers: { "x-veil-masked": String(session.size) } });
        },
      },
    },
    fetch: () => error(404, "veil proxies POST /v1/chat/completions only"),
  });
}
