type Seen = { route: string; headers: Record<string, string | null>; body: any };

const encoder = new TextEncoder();

function lastUserText(messages: any[]): string {
  const content = messages.findLast((m) => m.role === "user")?.content ?? "";
  if (typeof content === "string") return content;
  return content.map((part: any) => part.text ?? "").join(" ");
}

function pieces(text: string, size: number): string[] {
  const chars = [...text];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out;
}

function sse(events: Array<{ event?: string; data: string }>, split: number): Response {
  const wire = events.map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${e.data}\n\n`).join("");
  const bytes = encoder.encode(wire);
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < bytes.length; i += split) {
        controller.enqueue(bytes.slice(i, i + split));
        await Bun.sleep(0);
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

export function startMockUpstream(port = 9999, options: { chunkChars?: number; byteSplit?: number } = {}) {
  const chunkChars = options.chunkChars ?? 3;
  const byteSplit = options.byteSplit ?? 7;
  const seen: Seen[] = [];
  const say = (route: string, body: any) => {
    if (import.meta.main) console.log(`upstream ${route} received: ${JSON.stringify(body.messages)}`);
  };

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    routes: {
      "/v1/chat/completions": {
        POST: async (request) => {
          const body = (await request.json()) as any;
          seen.push({ route: "openai", headers: { authorization: request.headers.get("authorization") }, body });
          say("openai", body);
          const reply = `Noted. I will follow up with ${lastUserText(body.messages)}`;
          const base = { id: `chatcmpl-mock-${seen.length}`, created: Math.floor(Date.now() / 1000), model: body.model ?? "mock" };
          if (!body.stream) {
            return Response.json({
              ...base,
              object: "chat.completion",
              choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: reply } }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            });
          }
          const chunk = (delta: object, finish: string | null = null) => ({ data: JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] }) });
          const events = [chunk({ role: "assistant", content: "" }), ...pieces(reply, chunkChars).map((text) => chunk({ content: text }))];
          const target = reply.match(/⟦EMAIL_\d+⟧/)?.[0];
          if (body.tools && target) {
            events.push(chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "send_email", arguments: "" } }] }));
            for (const text of pieces(JSON.stringify({ to: target, subject: "Your refund" }), chunkChars)) {
              events.push(chunk({ tool_calls: [{ index: 0, function: { arguments: text } }] }));
            }
          }
          events.push(chunk({}, body.tools && target ? "tool_calls" : "stop"), { data: "[DONE]" });
          return sse(events, byteSplit);
        },
      },
      "/v1/messages": {
        POST: async (request) => {
          const body = (await request.json()) as any;
          seen.push({ route: "anthropic", headers: { "x-api-key": request.headers.get("x-api-key"), "anthropic-version": request.headers.get("anthropic-version") }, body });
          say("anthropic", body);
          const reply = `Understood. Replying to ${lastUserText(body.messages)}`;
          const message = { id: `msg_mock_${seen.length}`, type: "message", role: "assistant", model: body.model ?? "mock", stop_sequence: null };
          if (!body.stream) {
            return Response.json({ ...message, content: [{ type: "text", text: reply }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } });
          }
          const event = (type: string, data: object) => ({ event: type, data: JSON.stringify({ type, ...data }) });
          return sse(
            [
              event("message_start", { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } }),
              event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
              ...pieces(reply, chunkChars).map((text) => event("content_block_delta", { index: 0, delta: { type: "text_delta", text } })),
              event("content_block_stop", { index: 0 }),
              event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } }),
              event("message_stop", {}),
            ],
            byteSplit,
          );
        },
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
  });
  return { server, seen };
}

if (import.meta.main) {
  const { server } = startMockUpstream(Number(process.env.PORT ?? 9999));
  console.log(`mock upstream on ${server.url}v1 (echoes the last user message; streams in 3-character chunks)`);
}
