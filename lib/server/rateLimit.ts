/**
 * Rate limiting for the B4 auth routes (Phase B4).
 *
 * Design (spec §8): a replaceable store interface + a process-local in-memory
 * implementation suitable for the current single-process / local environment.
 *
 * LIMITATION — stated in code, docs and report: these limits are PER PROCESS
 * and NOT distributed. A multi-instance production deployment (e.g. several
 * Cloud Run instances) does NOT enforce these limits globally — each instance
 * counts independently. A shared store (Redis etc.) can be swapped in later
 * by providing another RateLimitStore; no route code changes. Do not claim
 * these limits are reliable across instances.
 *
 * Keys (B1 §1.8 + spec §8): register per IP; login per normalized-email+IP;
 * forgot/resend per normalized-email+IP (contract wording wins over the phase
 * file's "IP" shorthand, per phase_b4 §4); general mutations per player (or
 * IP when unauthenticated). Keys live only in memory and are never logged.
 */

export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimitStore {
  consume(key: string, limit: number, windowMs: number, now: number): RateDecision;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const PRUNE_THRESHOLD = 10_000;

class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();

  consume(key: string, limit: number, windowMs: number, now: number): RateDecision {
    let bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (this.buckets.size > PRUNE_THRESHOLD) this.prune(now);

    if (bucket.count > limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      return { allowed: false, retryAfterSeconds };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key);
    }
  }
}

/** Single-process store; replaceable by a shared store in a later phase. */
export const rateLimitStore: RateLimitStore = new MemoryRateLimitStore();

export const RATE_CLASSES = {
  /** auth.register — 5 / hour per IP */
  register: { limit: 5, windowMs: 60 * 60 * 1000 },
  /** auth.login — 10 / 15 minutes per email+IP */
  login: { limit: 10, windowMs: 15 * 60 * 1000 },
  /** auth.password.forgot + auth.resendVerification — 5 / hour per email+IP */
  credentialEmail: { limit: 5, windowMs: 60 * 60 * 1000 },
  /** general mutations (verify, reset, me.delete, …) — 60 / minute */
  general: { limit: 60, windowMs: 60 * 1000 },
  /**
   * B8: google.connectStart + google.accountReconnect — 10 / hour per player.
   * Tighter than `general` (each start mints a state and launches a provider
   * consent round-trip; contract §1.8 lists OAuth as rate-limited, architecture
   * §12 requires it). Reconnect also consumes a consent prompt at Google.
   */
  oauth: { limit: 10, windowMs: 60 * 60 * 1000 },
} as const;

export type RateClass = keyof typeof RATE_CLASSES;

/**
 * Best-effort client IP: first X-Forwarded-For entry when present (set by the
 * load balancer in deployment), otherwise a shared "unknown" bucket. Local
 * dev requests without a proxy share the "unknown" bucket — documented
 * limitation; spoofable XFF against a direct instance hit is a deployment
 * concern revisited when ingress is configured.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

/** Consume one hit for the given class+key suffix. */
export function checkRate(
  rateClass: RateClass,
  keySuffix: string,
  now: number = Date.now(),
): RateDecision {
  const { limit, windowMs } = RATE_CLASSES[rateClass];
  return rateLimitStore.consume(`${rateClass}:${keySuffix}`, limit, windowMs, now);
}
