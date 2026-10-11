/**
 * `?googleOAuth=` outcome handling (Phase B8, shared by B8a).
 *
 * The OAuth callback always redirects into the app carrying exactly ONE safe
 * token from this closed list (server never puts tokens/emails/params beyond
 * it in the Location header). Read once on mount, then the parameter is
 * scrubbed from the address bar. Previously SettingsScreen owned this; B8a
 * moves it here because SIGN-IN failures land signed OUT (AuthPanel, not
 * Settings) and must surface there too. Both components call
 * `readOAuthOutcomeToken()` in a mount effect — the first caller wins, the
 * second gets null (the parameter is already gone).
 */

/** Pure presentation (testable without a DOM — vitest runs in the node env). */
export function describeOAuthOutcome(token: string): string {
  return (
    OAUTH_OUTCOME_MESSAGES[token] ?? "Google sign-in finished with an unexpected result."
  );
}

/**
 * Safe outcome tokens the OAuth callback appends as `?googleOAuth=<code>`.
 * Messages cover both families: link (connected…) and B8a sign-in (signin…).
 */
export const OAUTH_OUTCOME_MESSAGES: Record<string, string> = {
  connected: "Google account connected.",
  signin: "Signed in with Google — welcome to the office!",
  denied: "Google sign-in was cancelled — nothing changed.",
  session: "Your session ended during Google sign-in — sign in and try again.",
  state: "That Google sign-in attempt expired or was already used — please try again.",
  nocode: "Google did not return an authorization code — please try again.",
  provider: "Google could not complete the sign-in — please try again.",
  unverified: "Google did not confirm a verified email for that account — sign-in refused.",
  conflict:
    "That Google account is already linked elsewhere, or this MailXP account already has a different Gmail connected. Each account keeps one Gmail — use the already-linked Google identity, or disconnect the current one first to switch.",
  config: "Google sign-in is not configured on this server.",
  account: "This account is scheduled for deletion — sign-in is disabled.",
};

/**
 * Read the outcome token ONCE and scrub it from the URL (client-only; effects
 * only — never during render, so SSR/hydration stays untouched). Returns null
 * when the parameter is absent or already consumed by the other view.
 */
export function readOAuthOutcomeToken(): string | null {
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get("googleOAuth");
  if (outcome === null) return null;
  const cleaned = new URL(window.location.href);
  cleaned.searchParams.delete("googleOAuth");
  window.history.replaceState({}, "", cleaned.toString());
  return outcome;
}
