/**
 * In-process SSE hub for GET /api/v1/events (Phase B5).
 *
 * Contract §5: cookie-authenticated, player-scoped streams (scope comes from
 * the server-side session only — a client id never selects it), minimal
 * pointer payloads (clients refetch REST), `retry: 5000` on connect, ~25 s
 * heartbeat, and §1.8's max of 3 concurrent streams per player.
 *
 * LIMITATION (stated in code, docs and report): this registry is PROCESS-LOCAL
 * — the connection cap and event fan-out are NOT guaranteed across instances
 * (multiple Cloud Run replicas would each hold their own streams). A shared
 * bus (Redis etc.) is the documented replacement seam; no route code changes.
 *
 * Events are emitted only AFTER a database commit by the publishing route
 * (phase §9). B5 publishes `profile.updated` from PATCH /game/preferences;
 * `economy.updated` starts at B6. There is no replay log (B1: Last-Event-ID
 * replay deferred to B12) — clients refetch on every (re)connect.
 */

/** Server-sent `retry:` directive (contract §5): reconnect hint, ms. */
export const SSE_RETRY_MS = 5000;
/** Heartbeat cadence (contract §5: "around every 25 seconds"). */
export const SSE_HEARTBEAT_MS = 25_000;
/**
 * Documented stream lifetime: the server closes each stream after this
 * interval so clients reconnect (EventSource auto-retries in SSE_RETRY_MS)
 * and refetch authoritative state — the contract's self-heal path. Anything
 * longer would let a half-dead connection linger indefinitely.
 */
export const SSE_MAX_STREAM_AGE_MS = 30 * 60 * 1000;
/** Contract §1.8: max 3 concurrent SSE streams per player (process-local). */
export const SSE_MAX_STREAMS_PER_PLAYER = 3;
/** Retry-After offered when the per-player stream cap is hit. */
export const SSE_CAP_RETRY_AFTER_SECONDS = 60;

export const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";

/** Serialize one named event in the SSE wire format (data must be JSON-safe). */
export function formatSseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The connect directive: browsers apply it before the first reconnect. */
export const SSE_RETRY_DIRECTIVE = `retry: ${SSE_RETRY_MS}\n\n`;

type Sink = (chunk: string) => void;

const subscribers = new Map<string, Set<Sink>>();

export type SubscribeResult = { ok: true; unsubscribe: () => void } | { ok: false; reason: "CAP" };

/**
 * Register a sink for a player's stream. Returns null-equivalent ("CAP") when
 * the player already has SSE_MAX_STREAMS_PER_PLAYER active streams (429).
 */
export function subscribeSse(playerId: string, sink: Sink): SubscribeResult {
  let set = subscribers.get(playerId);
  if (!set) {
    set = new Set();
    subscribers.set(playerId, set);
  }
  if (set.size >= SSE_MAX_STREAMS_PER_PLAYER) return { ok: false, reason: "CAP" };
  set.add(sink);

  let removed = false;
  const unsubscribe = (): void => {
    if (removed) return;
    removed = true;
    const current = subscribers.get(playerId);
    if (!current) return;
    current.delete(sink);
    if (current.size === 0) subscribers.delete(playerId);
  };
  return { ok: true, unsubscribe };
}

/**
 * Fan out one event to every active stream of a player.
 * Returns the number of streams the event reached. A throwing/closed sink is
 * dropped defensively (its route cleanup handles timers; this never throws).
 */
export function publishSse(playerId: string, name: string, data: unknown): number {
  const set = subscribers.get(playerId);
  if (!set || set.size === 0) return 0;
  const chunk = formatSseEvent(name, data);
  let delivered = 0;
  for (const sink of [...set]) {
    try {
      sink(chunk);
      delivered += 1;
    } catch {
      set.delete(sink);
    }
  }
  if (set.size === 0) subscribers.delete(playerId);
  return delivered;
}

/** Active stream count for a player (tests + diagnostics). */
export function sseSubscriberCount(playerId: string): number {
  return subscribers.get(playerId)?.size ?? 0;
}

/** Test-only: drop every registration between cases. */
export function resetSseHub(): void {
  subscribers.clear();
}
