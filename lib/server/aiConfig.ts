/**
 * Server-only AI configuration (Phase B10, phase_b10.md §6).
 *
 * All Gemini settings are OPTIONAL and fail CLOSED: without GEMINI_API_KEY
 * the inbox and Gmail sync keep working, the analysis job completes as a
 * safe `config` failure, and the API reports AI unavailable — never a crash,
 * never a fallback key, never a value in a log line or error message. Only
 * variable NAMES appear in errors and .env.example.
 */

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
export const DEFAULT_AI_DAILY_LIMIT = 20; // user decision 2026-10-11
export const DEFAULT_INPUT_MAX_CHARS = 8_000; // bounded body sent to the model
export const SUMMARY_MAX_CHARS = 1_000;
export const ACTION_TEXT_MAX_CHARS = 300;
export const SOURCE_TEXT_MAX_CHARS = 200;
export const MAX_ACTION_ITEMS = 10;
export const MAX_DEADLINES = 5;

export interface AiEnv {
  /** False when GEMINI_API_KEY is absent/blank — every AI path no-ops safely. */
  configured: boolean;
  apiKey: string | null;
  model: string;
  dailyLimit: number;
  inputMaxChars: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Read AI config from the given source (defaults to process.env — tests
 * inject their own). Never throws: a missing key simply yields
 * `configured: false`, which every caller treats as "AI unavailable".
 */
export function loadAiEnv(source: Record<string, string | undefined> = process.env): AiEnv {
  const apiKey = source.GEMINI_API_KEY?.trim() || null;
  return {
    configured: apiKey !== null,
    apiKey,
    model: source.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
    dailyLimit: positiveInt(source.AI_DAILY_LIMIT, DEFAULT_AI_DAILY_LIMIT),
    inputMaxChars: positiveInt(source.AI_INPUT_MAX_CHARS, DEFAULT_INPUT_MAX_CHARS),
  };
}
