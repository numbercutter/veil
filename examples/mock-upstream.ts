type Message = { role: string; content: string };

export function startMockUpstream(port = 9999) {
  const seen: Array<{ authorization: string | null; messages: Message[] }> = [];
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    routes: {
      "/v1/chat/completions": {
        POST: async (request) => {
          const body = (await request.json()) as { model?: string; messages: Message[] };
          seen.push({ authorization: request.headers.get("authorization"), messages: body.messages });
          if (import.meta.main) console.log(`upstream received: ${JSON.stringify(body.messages)}`);
          const last = body.messages.findLast((m) => m.role === "user")?.content ?? "";
          return Response.json({
            id: `chatcmpl-mock-${seen.length}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: body.model ?? "mock",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `Noted. I will follow up with ${last}` } }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          });
        },
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
  });
  return { server, seen };
}

if (import.meta.main) {
  const { server } = startMockUpstream(Number(process.env.PORT ?? 9999));
  console.log(`mock upstream on ${server.url}v1 (echoes the last user message)`);
}
