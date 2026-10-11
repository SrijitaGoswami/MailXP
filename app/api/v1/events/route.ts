/**
 * `events.stream` — GET /api/v1/events (B1 contract §5, phase_b5.md §9).
 *
 * Cookie-authenticated SSE: 401 UNAUTHENTICATED / 401 SESSION_EXPIRED before
 * any stream starts; the player scope comes ONLY from the server-side session
 * (a client-supplied id never selects it). Origin gate is the relaxed
 * stream variant `originConflicts` (403 CSRF_ORIGIN_REJECTED on a PRESENT
 * cross-site Origin; absent is allowed — browsers omit Origin on same-origin
 * EventSource GETs, verified live in B5 — the session cookie + CORS remain
 * the gates).
 *
 * Wire format: `retry: 5000` on connect, named events as minimal pointers
 * (`profile.updated` {version}; `economy.updated` starts at B6), and a `ping`
 * heartbeat every ~25 s (also keeps proxies alive). Streams are CLOSED by the
 * server after SSE_MAX_STREAM_AGE_MS (documented interval) — EventSource
 * auto-reconnects and the client refetches authoritative state on every
 * (re)connect; there is NO replay log (Last-Event-ID deferred to B12).
 *
 * Connection cap: §1.8's 3 concurrent streams per player, enforced by the
 * PROCESS-LOCAL hub (429 RATE_LIMITED + Retry-After when hit) — not a
 * cross-instance guarantee. Timers/listeners are torn down on cancel, abort
 * and max-age close (no leaks).
 *
 * This route does not use handle(): a streaming success response is a plain
 * Response, so the wrapper's semantics are reproduced here (request id on
 * every response, one category-only log line for unhandled throws).
 */

import { logger, resolveRequestId } from "@/lib/server/logger";
import {
  CODES,
  csrfRejected,
  errorCategory,
  errorResponse,
  originConflicts,
  rateLimitedResponse,
} from "@/lib/server/http";
import { getDb } from "@/lib/server/prisma";
import { loadSession, sessionErrorResponse } from "@/lib/server/session";
import {
  formatSseEvent,
  SSE_CAP_RETRY_AFTER_SECONDS,
  SSE_CONTENT_TYPE,
  SSE_HEARTBEAT_MS,
  SSE_MAX_STREAM_AGE_MS,
  SSE_MAX_STREAMS_PER_PLAYER,
  SSE_RETRY_DIRECTIVE,
  subscribeSse,
  sseSubscriberCount,
} from "@/lib/server/sseHub";

export const dynamic = "force-dynamic";

/** Attach the correlation header to a pre-built (envelope) response. */
function withRequestId(response: Response, requestId: string): Response {
  response.headers.set("X-Request-Id", requestId);
  return response;
}

const STREAM_HEADERS: Record<string, string> = {
  "Content-Type": SSE_CONTENT_TYPE,
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // Disable proxy buffering so events flush immediately.
  "X-Accel-Buffering": "no",
};

export async function GET(request: Request): Promise<Response> {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  try {
    // Origin gate first (relaxed stream rule — see originConflicts doc).
    if (originConflicts(request)) return withRequestId(csrfRejected(requestId), requestId);

    const db = getDb();
    const session = await loadSession(db, request);
    if (!session.ok) return withRequestId(sessionErrorResponse(session.reason, requestId), requestId);

    const playerId = session.user.id;

    // §1.8 cap — checked and registered synchronously (no await between), so
    // two concurrent connects cannot both slip past the limit.
    if (sseSubscriberCount(playerId) >= SSE_MAX_STREAMS_PER_PLAYER) {
      return withRequestId(rateLimitedResponse(requestId, SSE_CAP_RETRY_AFTER_SECONDS), requestId);
    }

    let enqueue: ((chunk: string) => void) | null = null;
    let closeStream: (() => void) | null = null;
    let tornDown = false;

    const subscription = subscribeSse(playerId, (chunk) => {
      enqueue?.(chunk);
    });
    if (!subscription.ok) {
      return withRequestId(rateLimitedResponse(requestId, SSE_CAP_RETRY_AFTER_SECONDS), requestId);
    }

    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let maxAge: ReturnType<typeof setTimeout> | null = null;

    const teardown = (): void => {
      if (tornDown) return;
      tornDown = true;
      subscription.unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      if (maxAge) clearTimeout(maxAge);
      heartbeat = null;
      maxAge = null;
      closeStream?.();
    };

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        enqueue = (chunk: string) => {
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            teardown(); // controller already closed — drop the dead sink
          }
        };
        closeStream = () => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };

        try {
          controller.enqueue(encoder.encode(SSE_RETRY_DIRECTIVE));
        } catch {
          teardown();
          return;
        }

        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(formatSseEvent("ping", {})));
          } catch {
            teardown();
          }
        }, SSE_HEARTBEAT_MS);
        maxAge = setTimeout(() => teardown(), SSE_MAX_STREAM_AGE_MS);

        // Never keep the process alive on account of stream timers.
        (heartbeat as unknown as { unref?: () => void }).unref?.();
        (maxAge as unknown as { unref?: () => void }).unref?.();
      },
      cancel() {
        teardown();
      },
    });

    // Client disconnect (browser tab closed, proxy drop) → cleanup.
    request.signal.addEventListener("abort", () => teardown(), { once: true });

    return new Response(stream, { status: 200, headers: { ...STREAM_HEADERS, "X-Request-Id": requestId } });
  } catch (error) {
    logger.error("route.unhandled", {
      requestId,
      routeId: "events.stream",
      category: errorCategory(error),
    });
    return withRequestId(
      errorResponse(500, CODES.INTERNAL_ERROR, "An unexpected error occurred.", requestId),
      requestId,
    );
  }
}
