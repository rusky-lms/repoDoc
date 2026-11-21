// ─────────────────────────────────────────────────────────────────────────────
// repoDoc Local — LocalLLM: Ollama inference module
// All network calls stay on localhost:11434 only.
// ─────────────────────────────────────────────────────────────────────────────

import { ModelTier } from "./types.js";

export interface LLMOptions {
  model: ModelTier;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface LLMResponse {
  text: string;
  tokensUsed?: number;
  promptTokens?: number;
  doneReason?: string;
  durationMs: number;
}

export interface CompleteOptions {
  format?: string | "json";
  think?: boolean;
  options?: {
    num_ctx?: number;
    num_predict?: number;
    temperature?: number;
    [key: string]: unknown;
  };
}

const OLLAMA_BASE = "http://localhost:11434";

/**
 * Map a ModelTier to the Ollama model tag.
 * NOTE: Tags are gemma3 placeholders; update to real Gemma 4 tags in Phase 0.
 */
export function getOllamaTag(tier: ModelTier): string {
  switch (tier) {
    case "gemma-4-e4b":
      return "gemma4:e4b";
    case "gemma-4-e2b":
      return "gemma4:e2b";
    default: {
      const _exhaustive: never = tier;
      throw new Error(`Unknown ModelTier: ${_exhaustive}`);
    }
  }
}

export class LocalLLM {
  private ollamaTag: string;

  constructor(private options: LLMOptions) {
    this.ollamaTag = getOllamaTag(options.model);
  }

  /**
   * Check whether Ollama is reachable on localhost.
   * Returns true on HTTP 200, false on any error.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${OLLAMA_BASE}/api/tags`);
      if (res.ok) return true;
      return false;
    } catch {
      console.error(
        "Ollama is not running. Start it with: ollama serve"
      );
      return false;
    }
  }

  /**
   * Run a one-shot (non-streaming) completion.
   */
  async complete(prompt: string, callOpts?: CompleteOptions): Promise<LLMResponse> {
    const start = Date.now();

    let res: Response;
    try {
      res = await fetch(`${OLLAMA_BASE}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.ollamaTag,
          prompt,
          stream: false,
          format: callOpts?.format !== undefined ? callOpts.format : "json",
          think: callOpts?.think ?? false,
          options: {
            num_ctx: callOpts?.options?.num_ctx ?? 8192,
            num_predict: callOpts?.options?.num_predict ?? 1024,
            temperature: callOpts?.options?.temperature ?? 0,
            ...callOpts?.options,
          },
        }),
      });
    } catch (err) {
      throw new Error(
        `Failed to reach Ollama at ${OLLAMA_BASE}. Is it running? (ollama serve)\n${err}`
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Ollama returned HTTP ${res.status}: ${body}`
      );
    }

    let json: {
      response: string;
      eval_count?: number;
      prompt_eval_count?: number;
      done_reason?: string;
    };
    try {
      json = (await res.json()) as typeof json;
    } catch (err) {
      throw new Error(`Failed to parse Ollama response JSON: ${err}`);
    }

    return {
      text: json.response,
      tokensUsed: json.eval_count,
      promptTokens: json.prompt_eval_count,
      doneReason: json.done_reason,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Stream a completion, yielding text chunks as they arrive.
   * Uses NDJSON (one JSON object per line, stream: true).
   */
  async *stream(prompt: string): AsyncGenerator<string> {
    let res: Response;
    try {
      res = await fetch(`${OLLAMA_BASE}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.ollamaTag,
          prompt,
          stream: true,
          format: "json",
          think: false,
          options: {
            num_ctx: 8192,
            num_predict: 1024,
            temperature: 0,
          },
        }),
      });
    } catch (err) {
      throw new Error(
        `Failed to reach Ollama at ${OLLAMA_BASE}. Is it running? (ollama serve)\n${err}`
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Ollama returned HTTP ${res.status}: ${body}`);
    }

    if (!res.body) {
      throw new Error("Ollama response has no body — cannot stream.");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last (potentially incomplete) line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const chunk = JSON.parse(trimmed) as {
              response?: string;
              done?: boolean;
            };
            if (chunk.response) {
              yield chunk.response;
            }
            if (chunk.done) return;
          } catch {
            // Malformed line — skip silently
          }
        }
      }

      // Flush any remaining bytes
      const remaining = decoder.decode(undefined, { stream: false });
      if (remaining.trim()) {
        try {
          const chunk = JSON.parse(remaining.trim()) as {
            response?: string;
          };
          if (chunk.response) yield chunk.response;
        } catch {
          // ignore
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
