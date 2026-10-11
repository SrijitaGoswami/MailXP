MailXP B8b — One-Gmail-Per-MailXP-Account Hardening
Purpose: Fix and verify the one-Gmail-per-MailXP-account rule after B8/B8a before any Gmail sync work. Implement B8b only, write docs/B8B_REPORT.md, then stop for approval.
1. Read and inspect first
Read docs/B8_REPORT.md including B8a, docs/phase_b8.md, docs/phase_b8a.md, and the master requirements, phase plan, architecture, and API contract. Inspect current schema/code and run baseline checks.
B8 reports real Google OAuth and B8a sign-in. It reports two GoogleConnection rows, including one created during a second real sign-in, but its summary does not prove whether both belong to the same MailXP user. Inspect only safe fields: connection ID, owner user ID, email, status, timestamps. Never select or print encrypted token columns, OAuth state hashes, .env values, client secrets, or encryption keys.
Do not delete/revoke either connection until ownership and the user's intended Gmail are unambiguous. If unclear, stop and ask. Never delete unrelated accounts, profiles, inventory, DraftCoin ledger, or game data.
2. Required policy
- Each MailXP user may have at most one active/connected Google mailbox.
- Each Google identity may be linked to at most one MailXP user.
- Never silently replace, merge, transfer, or add a second mailbox.
- Keep real Google-hosted OAuth, server-side code exchange, verified identity, and existing session protections.
- Do not create extra MailXP accounts to accommodate another Gmail identity.
3. Link/connect behavior
- If no active connection exists, allow the existing OAuth flow.
- If the same googleSub is already connected to this user, reconnect/update that row in place.
- If this user already has a different connected googleSub, reject the attempt safely. Do not add a row or overwrite credentials.
- Switching Gmail requires explicit disconnect/release first, then a fresh connection.
- Keep the existing verified-email gate and origin/CSRF/rate-limit protections.
4. Signed-out Google sign-in behavior
- Keep the approved B8a policy: resolve verified provider subject first, then the verified normalized-email account match.
- If the identity is already linked, sign in to its owning MailXP account unless it is pending deletion.
- If the verified email matches a MailXP account that already has a different active Google identity, do not attach another connection, silently switch Gmail, or create a duplicate MailXP account. Return a safe, understandable conflict/outcome asking the user to use the already-linked Google identity or explicitly switch while signed in.
- If the matched password account has no Google connection, follow the approved B8a flow, linking only if all checks pass.
- Never merge accounts based on unverified email. Never trust browser-supplied email, sub, token, or verification status.
- Only set/rotate the MailXP session on successful sign-in. Preserve URL scrubbing and safe outcomes.
5. Database invariant
Enforce in PostgreSQL that a user cannot have more than one connected GoogleConnection row. A reviewed partial unique index on userId WHERE status = 'connected' is acceptable. Preserve unique googleSub. Released historical rows may remain but must not permit two active rows for one user. Ensure reconnect, sign-in, release, disconnect, and concurrent callbacks cannot bypass the invariant. Map uniqueness races to a safe conflict, never SQL/Prisma details.
Review additive migration SQL before applying. Run npx prisma generate after schema changes. If Prisma cannot express the partial index, use reviewed raw migration SQL and document drift checking.
6. Existing connections and UI
- If the two existing connections belong to different MailXP users and each has one active connection, do not delete either merely because the total is two.
- If one user has multiple active connections, do not choose automatically. Ask the user which Gmail to keep unless the unwanted test connection is unambiguously identified by explicit instruction.
- Any approved cleanup must use the normal disconnect/revoke path where possible and record honest revocation outcome. Never claim revocation succeeded unless confirmed.
- No broad deleteMany, database reset, truncation, or account recreation.
- Settings should show one current Gmail. Remove/replace the “Connect another Google account” affordance with a clearly explained “Switch Gmail” flow requiring explicit disconnect/release first.
- Explain that disconnect removes MailXP's local connection and may attempt token revocation; it does not delete Gmail messages.
7. Tests
Test: no-connection connect; same-sub reconnect; different-sub second connection rejected; concurrent callbacks cannot create two active rows; sign-in chooses the linked account; email match to an account with a different active connection does not attach a second one; email match to an account with no Google connection follows B8a without duplicate account creation; explicit switch; pending-deletion guard; identity cannot link to two users; token redaction/no plaintext fallback; account deletion cleanup; existing auth/economy/SSE/worker/game regressions; UI one-mailbox affordance.
8. Final validation
Run sequentially on the unchanged final state:
1. npx vitest run
2. npx tsc --noEmit
3. npm run build
4. npx prisma validate
5. npx prisma migrate status
6. Live PostgreSQL tests for ownership and uniqueness.
7. Browser checks for / and /preview: exactly one Phaser canvas each, no unexpected console errors.
8. Confirm safe connection counts/ownership and clean only test-created rows.
Fix failures and rerun the full sequence. Report intermediate failures honestly.
9. Forbidden in B8b
No Gmail message fetching/history sync/labels/push, Gemini, send/draft/archive/label actions, Calendar, wallet, ALGO, NFTs, production deployment, real Google password collection, fake OAuth, account merging, silent mailbox replacement, broad database cleanup, or unrelated UI/game changes. Do not touch public/assets/mailxp/ without an approved requirement.
10. Required report and stop
Create docs/B8B_REPORT.md with safe before/after connection counts and ownership mapping; whether any user had multiple active connections; implemented invariant; any cleanup and its rationale; migration summary; changed/untouched files; all tests/build/migration/browser results and intermediate failures; confirmation real OAuth remains and no Gmail message APIs were added; remaining limitations.
Then stop. Do not begin B9 until the user reviews B8B and explicitly approves.