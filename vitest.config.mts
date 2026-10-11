import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Phase B2: unit tests for the persistence seam (game/profile.ts +
// game/profileStorage.ts). Phase B3 added server-only tests (lib/server/**,
// health route). Phase B4 adds auth routes, policies, and a LIVE database
// integration suite — .env is loaded here (Node 24 built-in, no dotenv dep)
// so the integration suite can reach DATABASE_URL; when .env is absent the
// suite self-skips. Values are never printed. The "@" alias mirrors
// tsconfig's "@/*".
try {
  process.loadEnvFile();
} catch {
  /* no .env — live DB suite reports itself as skipped */
}

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // bcryptjs work (cost 10) makes auth flows legitimately slow-ish; 15 s
    // still fails genuinely hung tests.
    testTimeout: 15_000,
    // B7: "*.test.ts" (root, non-recursive) so instrumentation.test.ts sits
    // beside its subject instrumentation.ts at the repo root.
    include: ["*.test.ts", "game/**/*.test.ts", "lib/**/*.test.ts", "app/**/*.test.ts", "components/**/*.test.ts"],
  },
});
