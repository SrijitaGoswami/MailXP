/**
 * Gemini provider adapter (Phase B10, phase_b10.md §6).
 *
 * Server-only. The ONLY module that may touch the Gemini SDK. Route handlers,
 * React, Phaser, and the job pipeline never import it — the pipeline receives
 * an injected `GeminiGenerateFn` (same audited-boundary pattern as
 * lib/server/gmailApi.ts, whose host allow-list is tested).
 *
 * Safety properties:
 *   - fail closed: a missing key throws GeminiApiError("config") before any
 *     network call; nothing is ever hard-coded or defaulted;
 *   - timeouts: every call is bounded by GEMINI_TIMEOUT_MS via a race;
 *   - retries: intentionally NONE in-module — the durable job queue already
 *     owns bounded exponential backoff with jitter (lib/server/jobQueue.ts),
 *     so in-call retries would multiply attempts and cost;
 *   - categorisation: every failure maps to a small safe category
 *     (quota|auth|config|timeout|provider|permanent) that the worker uses for
 *     retry policy and the UI for honest status — never a raw provider error;
 *   - privacy: message content, prompts, API keys, and provider response
 *     bodies are never logged or embedded in error messages.
 */

import { loadAiEnv, type AiEnv } from "@/lib/server/aiConfig";

export const GEMINI_TIMEOUT_MS = 20_000;

export type GeminiErrorCategory = "quota" | "auth" | "config" | "timeout" | "provider" | "permanent";

export class GeminiApiError extends Error {
  readonly category: GeminiErrorCategory;

  constructor(category: GeminiErrorCategory, message?: string) {
    super(message ?? `gemini: ${category}`);
    this.name = "GeminiApiError";
    this.category = category;
  }
}

export interface GeminiGenerateInput {
  apiKey: string;
  model: string;
  systemInstruction: string;
  /** Untrusted email, already delimited and size-bounded by aiSchema.ts. */
  userContent: string;
  timeoutMs?: number;
}

/**
 * The injectable provider boundary. Unit tests pass a fake; production wires
 * `createGeminiGenerate()` (the SDK-backed default) in aiAnalysis.ts.
 */
export type GeminiGenerateFn = (input: GeminiGenerateInput) => Promise<string>;

/** Map an unknown SDK/network failure to a safe category. Never echoes text. */
export function classifyGeminiError(error: unknown): GeminiApiError {
  if (error instanceof GeminiApiError) return error;

  const candidate = error as { status?: unknown; message?: unknown; code?: unknown; name?: unknown } | null;
  const status = typeof candidate?.status === "number" ? candidate.status : null;
  const message = typeof candidate?.message === "string" ? candidate.message : "";

  if (/timeout|timed out|aborted|AbortError/i.test(message) || candidate?.name === "AbortError") {
    return new GeminiApiError("timeout");
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(message)) {
    return new GeminiApiError("quota");
  }
  if (
    status === 401 ||
    status === 403 ||
    /API_KEY_INVALID|UNAUTHENTICATED|PERMISSION_DENIED|API key not valid/i.test(message)
  ) {
    // An invalid/revoked key is not fixed by retrying — permanent until the
    // operator rotates the key (phase_b10.md §6: never retry auth forever).
    return new GeminiApiError("auth");
  }
  if (status !== null && status >= 400 && status < 500) {
    return new GeminiApiError("permanent");
  }
  return new GeminiApiError("provider");
}

/**
 * SDK-backed default. Dynamically imported so that modules which only need
 * the TYPE (routes, tests with fakes) never load the SDK, and so a missing
 * optional dependency can never break `next build`.
 */
export function createGeminiGenerate(): GeminiGenerateFn {
  return async (input: GeminiGenerateInput): Promise<string> => {
    if (!input.apiKey) throw new GeminiApiError("config");

    let GoogleGenAI: typeof import("@google/genai").GoogleGenAI;
    try {
      ({ GoogleGenAI } = await import("@google/genai"));
    } catch {
      throw new GeminiApiError("config");
    }

    const timeoutMs = input.timeoutMs ?? GEMINI_TIMEOUT_MS;
    const client = new GoogleGenAI({ apiKey: input.apiKey });

    const call = (async (): Promise<string> => {
      try {
        const response = await client.models.generateContent({
          model: input.model,
          contents: input.userContent,
          config: {
            systemInstruction: input.systemInstruction,
            responseMimeType: "application/json",
            temperature: 0.2,
            maxOutputTokens: 1024,
          },
        });
        const text = response.text;
        if (typeof text !== "string" || text.trim() === "") {
          throw new GeminiApiError("provider");
        }
        return text;
      } catch (error) {
        throw classifyGeminiError(error);
      }
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new GeminiApiError("timeout")), timeoutMs);
    });
    try {
      return await Promise.race([call, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

/** Current configuration snapshot for the wired default (never the key). */
export function geminiConfigSnapshot(env: AiEnv = loadAiEnv()): { configured: boolean; model: string } {
  return { configured: env.configured, model: env.model };
}
