/**
 * Server-Sent Events: a streaming Response and a sink to write events into it.
 * The stream stays open until `run` finishes; if the client goes away, the
 * signal passed to `run` aborts and later sends are dropped.
 */

export type Send = (event: string, data: unknown) => void;

export function formatEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function sseResponse(run: (send: Send, signal: AbortSignal) => Promise<void>, requestSignal?: AbortSignal): Response {
  const disconnected = new AbortController();
  const signal = requestSignal ? AbortSignal.any([requestSignal, disconnected.signal]) : disconnected.signal;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send: Send = (event, data) => {
        if (!open || signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(formatEvent(event, data)));
        } catch {
          open = false; // the client is gone
        }
      };
      try {
        await run(send, signal);
      } catch (err) {
        console.error("[API] search failed:", err);
      } finally {
        open = false;
        try {
          controller.close();
        } catch {
          // already closed or cancelled
        }
      }
    },
    cancel() {
      disconnected.abort(new Error("client disconnected"));
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
