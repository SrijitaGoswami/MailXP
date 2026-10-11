import { defineConfig } from "prisma/config";

// Prisma 7 no longer auto-loads .env for CLI commands (the config loader runs
// with dotenv disabled). Node 21.7+ can load it natively — no extra dependency.
try {
  process.loadEnvFile();
} catch {
  // No .env yet: schema-only commands (validate/format) still work; any command
  // that needs the database then fails with a clear "datasource not configured"
  // style error. See .env.example for setup.
}

const url = process.env.DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  // Conditional so `prisma validate`/`format` stay usable before .env exists.
  // Migration/introspection commands require DATABASE_URL (see .env.example).
  ...(url ? { datasource: { url } } : {}),
  migrations: {
    path: "prisma/migrations",
  },
});
