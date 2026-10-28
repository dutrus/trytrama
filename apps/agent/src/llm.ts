/**
 * Small layer over Gemini's REST API (plain fetch, no SDK). Streams text as it
 * arrives and returns the model's parts exactly as received: Gemini 3 attaches
 * a thoughtSignature that must be sent back unchanged in the history.
 * Retries 503 and 429; when Gemini stays unavailable it throws an LlmError with
 * a message meant for the terminal. The API key never appears in any message.
 */

export interface Part {
  text?: string;
  /** A thought summary; not shown to the user. */
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
}

export interface Content {
  role: "user" | "model";
  parts: Part[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  contents: Content[];
  tools: FunctionDeclaration[];
}

export interface Llm {
  /** Streams visible text to onText; resolves with every part of the model's turn. */
  generate(req: LlmRequest, onText: (text: string) => void): Promise<Part[]>;
}

/** A failure to show as is in the terminal. */
export class LlmError extends Error {
  override name = "LlmError";
}

export interface GeminiOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxRetries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([429, 503]);

export function createGemini(opts: GeminiOptions = {}): Llm {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? "";
  const model = opts.model ?? process.env.GEMINI_MODEL ?? "gemini-3.5-flash";
  const baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  const maxRetries = opts.maxRetries ?? 3;
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const hide = (s: string) => (apiKey ? s.replaceAll(apiKey, "***") : s);

  return {
    async generate(req, onText) {
      if (!apiKey) throw new LlmError("Falta GEMINI_API_KEY. Agregala al .env y volvé a intentar.");
      const body = JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: req.contents,
        tools: [{ functionDeclarations: req.tools }],
      });

      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await doFetch(`${baseUrl}/models/${model}:streamGenerateContent?alt=sse`, {
            method: "POST",
            headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
            body,
          });
        } catch {
          throw new LlmError("No pude conectarme con Gemini. Revisá la conexión y volvé a intentar.");
        }

        if (res.ok && res.body) return readStream(res.body, onText);

        const detail = hide(await res.text().catch(() => ""));
        if (RETRYABLE.has(res.status) && attempt < maxRetries) {
          await sleep(retryDelayMs(res, detail, attempt));
          continue;
        }
        throw new LlmError(failureMessage(res.status, model));
      }
    },
  };
}

async function readStream(body: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<Part[]> {
  const parts: Part[] = [];
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const chunk = JSON.parse(line.slice(5));
        for (const part of (chunk.candidates?.[0]?.content?.parts ?? []) as Part[]) {
          parts.push(part);
          if (part.text && !part.thought) onText(part.text);
        }
      }
    }
  } catch {
    throw new LlmError("Se cortó la respuesta de Gemini a la mitad. Volvé a intentar.");
  }
  return parts;
}

/** Retry-After header, then the RetryInfo delay in a 429 body, then exponential backoff. */
function retryDelayMs(res: Response, body: string, attempt: number): number {
  const header = Number(res.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const fromBody = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (fromBody) return Number(fromBody[1]) * 1000;
  return 1000 * 2 ** attempt;
}

function failureMessage(status: number, model: string): string {
  if (status === 503) return "Gemini no está disponible ahora (503, demasiada demanda). Probá de nuevo en un rato.";
  if (status === 429) return "Se alcanzó el límite de pedidos a Gemini (429). Esperá un minuto y volvé a intentar.";
  if (status === 401 || status === 403) return "Gemini rechazó la clave (GEMINI_API_KEY). Revisá que sea válida.";
  if (status === 404) return `El modelo ${model} no existe o no está disponible para esta cuenta. Probá con otro en GEMINI_MODEL.`;
  return `Gemini respondió con un error (${status}).`;
}
