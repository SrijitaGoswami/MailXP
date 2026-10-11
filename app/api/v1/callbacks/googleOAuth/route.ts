/**
 * GET /api/v1/callbacks/googleOAuth — `google.connectCallback` (B8, contract
 * §8 provider-callback boundary; B8a adds the `signin` branch).
 *
 * This is a top-level GET navigation arriving from Google, so:
 *  - NO Origin gate (browsers send no Origin on top-level GET navigations;
 *    http.originConflicts would 403 every real callback). The CSRF defense is
 *    the state itself: 256-bit random, stored hash-only, 10-minute expiry,
 *    consumed EXACTLY ONCE via a guarded update — validated BEFORE any code
 *    exchange (spec §4.4). Link/reconnect states are additionally bound to
 *    the initiating user + session; B8a `signin` states are UNBOUND (no
 *    session exists when the flow starts) — the random state alone guards
 *    them, exactly like the state parameter in any standard OAuth client.
 *  - The response is always a 307 redirect back into the app carrying one
 *    SAFE outcome token (`/?googleOAuth=<code>`). No code, state, tokens,
 *    emails, or raw provider payloads ever appear in the Location header or
 *    any response body (§4.10). Only the SIGN-IN success path sets the
 *    session cookie (on the redirect itself) — the link path never touches
 *    the session (§4.11).
 *  - Identity comes only from Google's userinfo endpoint (server-minted
 *    access token from OUR code exchange) and must report email_verified
 *    (§4.5–§4.6). Linking is synchronous (B8 §11 deviation, recorded).
 *
 * Branching (B8a): the state row is looked up hash-only FIRST and its
 * stored `intent` — never anything browser-supplied — picks the path:
 *  - "signin": consume unbound → exchange → locate-or-create account
 *    (sub-wins / email-match / create-verified, phase_b8a.md §3.3) →
 *    rotate session (login parity) → link identity → audit → redirect
 *    `signin` WITH the new session cookie. Fail-closed conflict sentinel
 *    rolls the whole transaction back.
 *  - "connect" | "reconnect:<id>": the B8 flow unchanged (session binding).
 */

import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/server/audit";
import {
  consumeOAuthState,
  consumeSignInState,
  exchangeCode,
  fetchGoogleIdentity,
  GoogleProviderError,
  GoogleUnverifiedEmailError,
  linkGoogleIdentity,
  peekOAuthState,
  requireGoogleConfig,
  resolveSignInTarget,
  SignInLinkConflictError,
} from "@/lib/server/googleOAuth";
import { handle } from "@/lib/server/http";
import { logger } from "@/lib/server/logger";
import { getDb } from "@/lib/server/prisma";
import {
  applySessionCookie,
  createSession,
  hashSessionToken,
  loadSession,
  readSessionCookie,
  revokeSession,
} from "@/lib/server/session";

export const dynamic = "force-dynamic";

type Outcome =
  | "connected"
  | "signin"
  | "denied"
  | "state"
  | "session"
  | "nocode"
  | "provider"
  | "unverified"
  | "conflict"
  | "config"
  | "account";

const INTENT_PREFIX = "reconnect:";

interface ExchangedIdentity {
  refreshToken: string | null;
  grantedScopes: string;
  identity: { sub: string; email: string };
}

/**
 * Server-side code exchange + trusted identity lookup, shared by both
 * branches (browser input never supplies identity, tokens, or scopes).
 * Returns null on the safe redirect for provider-shaped failures.
 */
async function exchangeForIdentity(
  code: string,
  config: ReturnType<typeof requireGoogleConfig>,
  redirect: (outcome: Outcome) => NextResponse,
): Promise<{ ok: true; value: ExchangedIdentity } | { ok: false; response: NextResponse }> {
  try {
    const exchanged = await exchangeCode(config, code);
    const identity = await fetchGoogleIdentity(exchanged.accessToken, fetch);
    return {
      ok: true,
      value: { refreshToken: exchanged.refreshToken, grantedScopes: exchanged.grantedScopes, identity },
    };
  } catch (error) {
    if (error instanceof GoogleUnverifiedEmailError) return { ok: false, response: redirect("unverified") };
    if (error instanceof GoogleProviderError) return { ok: false, response: redirect("provider") };
    throw error; // unexpected → sanitized 500 by handle()
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request, "google.connectCallback", async (requestId) => {
    const url = new URL(request.url);
    const redirect = (outcome: Outcome, sessionToken?: string): NextResponse => {
      logger.info("oauth.callback", { requestId, outcome });
      const response = NextResponse.redirect(new URL(`/?googleOAuth=${outcome}`, url.origin));
      if (sessionToken !== undefined) applySessionCookie(response, sessionToken);
      return response;
    };

    const db = getDb();

    // 1. Validate + consume state exactly once, BEFORE touching the code.
    //    The row's stored intent picks the branch (never browser input).
    const state = url.searchParams.get("state");
    if (state === null) return redirect("state");
    const peeked = await peekOAuthState(db, state);
    if (peeked === null) return redirect("state");

    // ---- B8a: "Continue with Google" sign-in -----------------------------
    if (peeked.intent === "signin") {
      const consumed = await consumeSignInState(db, state);
      if (!consumed.ok) return redirect("state"); // missing/expired/replayed/bound

      if (url.searchParams.get("error") !== null) return redirect("denied");
      const code = url.searchParams.get("code");
      if (code === null || code === "") return redirect("nocode");

      let config: ReturnType<typeof requireGoogleConfig>;
      try {
        config = requireGoogleConfig();
      } catch {
        return redirect("config");
      }

      const exchange = await exchangeForIdentity(code, config, redirect);
      if (!exchange.ok) return exchange.response;
      const { refreshToken, grantedScopes, identity } = exchange.value;

      // Locate-or-create + rotate + link + audit in ONE transaction: a link
      // conflict throws the sentinel, rolling back the created account and
      // the new session together (fail closed, phase_b8a.md §3.4).
      let result: { kind: "ok"; token: string; created: boolean } | { kind: "account_disabled" };
      try {
        result = (await db.$transaction(async (tx) => {
          const resolution = await resolveSignInTarget(tx, identity);
          if (!resolution.ok) return { kind: "account_disabled" } as const;

          // Rotation parity with auth.login: revoke whatever session rode
          // along (an account switch must not leave the old one usable).
          const presented = readSessionCookie(request);
          if (presented !== null) {
            const existing = await tx.session.findUnique({
              where: { tokenHash: hashSessionToken(presented) },
            });
            if (existing) await revokeSession(tx, existing.id);
          }

          const session = await createSession(tx, resolution.userId);
          const linked = await linkGoogleIdentity(tx, {
            userId: resolution.userId,
            identity,
            refreshToken,
            grantedScopes,
            encryptionKey: config.encryptionKey,
          });
          if (!linked.ok) throw new SignInLinkConflictError();

          await recordAudit(tx, {
            userId: resolution.userId,
            eventType: resolution.disposition === "created" ? "auth.register_google" : "auth.login_google",
            requestId,
          });
          const eventType =
            linked.outcome === "linked"
              ? "google.connected"
              : linked.outcome === "reconnected"
                ? "google.reconnected"
                : "google.transferred";
          await recordAudit(tx, {
            userId: resolution.userId,
            eventType,
            requestId,
            meta: { accountId: linked.account.id },
          });
          return { kind: "ok", token: session.token, created: resolution.disposition === "created" } as const;
        })) as { kind: "ok"; token: string; created: boolean } | { kind: "account_disabled" };
      } catch (error) {
        if (error instanceof SignInLinkConflictError) {
          await db.$transaction(async (tx) => {
            await recordAudit(tx, { userId: null, eventType: "google.link_conflict", requestId });
          });
          return redirect("conflict");
        }
        throw error;
      }

      if (result.kind === "account_disabled") return redirect("account");
      return redirect("signin", result.token);
    }

    // ---- B8: link / reconnect (unchanged) ---------------------------------
    // The initiating session must be present (its cookie rides along on
    // the top-level navigation) — without it no binding can be checked.
    const session = await loadSession(db, request);
    if (!session.ok) return redirect("session");

    const consumed = await consumeOAuthState(db, state, {
      userId: session.user.id,
      sessionId: session.session.id,
    });
    if (!consumed.ok) return redirect("state"); // missing/expired/replayed/wrong-user

    // 3. Provider refusal (user cancelled) — no exchange, no mutation.
    if (url.searchParams.get("error") !== null) return redirect("denied");

    const code = url.searchParams.get("code");
    if (code === null || code === "") return redirect("nocode");

    // 4. Configuration must still be present (env could have changed mid-flow).
    let config: ReturnType<typeof requireGoogleConfig>;
    try {
      config = requireGoogleConfig();
    } catch {
      return redirect("config");
    }

    // 5. Reconnect intents must still point at THIS player's row.
    const intent = consumed.row.intent;
    if (intent.startsWith(INTENT_PREFIX)) {
      const accountId = intent.slice(INTENT_PREFIX.length);
      const target = await db.googleConnection.findUnique({ where: { id: accountId } });
      if (!target || target.userId !== session.user.id) return redirect("state");
    }

    // 6. Server-side code exchange + trusted identity lookup (browser input
    //    never supplies identity, tokens, or scopes).
    const exchange = await exchangeForIdentity(code, config, redirect);
    if (!exchange.ok) return exchange.response;
    const { refreshToken, grantedScopes, identity } = exchange.value;

    // 7. Link (or re-link / transfer) + audit in ONE transaction.
    const linked = await db.$transaction(async (tx) => {
      const result = await linkGoogleIdentity(
        tx,
        {
          userId: session.user.id,
          identity,
          refreshToken,
          grantedScopes,
          encryptionKey: config.encryptionKey,
        },
      );
      if (!result.ok) return { conflict: true as const };
      const eventType =
        result.outcome === "linked"
          ? "google.connected"
          : result.outcome === "reconnected"
            ? "google.reconnected"
            : "google.transferred";
      await recordAudit(tx, {
        userId: session.user.id,
        eventType,
        requestId,
        meta: { accountId: result.account.id },
      });
      return { conflict: false as const };
    });

    if (linked.conflict) {
      // Another player's ACTIVE connection — refuse without transferring
      // anything (§4.8); keep security-relevant evidence of the attempt.
      await db.$transaction(async (tx) => {
        await recordAudit(tx, {
          userId: session.user.id,
          eventType: "google.link_conflict",
          requestId,
        });
      });
      return redirect("conflict");
    }

    return redirect("connected");
  });
}
