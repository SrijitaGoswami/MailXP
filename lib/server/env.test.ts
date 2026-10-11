/** Phase B3 — server environment validation tests (values never asserted or printed). */

import { describe, expect, it } from "vitest";
import { loadServerEnv } from "./env";

const FAKE_SECRET = "super-secret-db-password-xyz";

describe("loadServerEnv", () => {
  it("accepts a well-formed postgresql URL and trims it", () => {
    const env = loadServerEnv({ DATABASE_URL: ` postgres://user:${FAKE_SECRET}@localhost:5432/mailxp_dev ` });
    expect(env.databaseUrl).toBe(`postgres://user:${FAKE_SECRET}@localhost:5432/mailxp_dev`);
  });

  it("accepts the postgres:// shorthand", () => {
    expect(loadServerEnv({ DATABASE_URL: "postgres://localhost:5432/db" }).databaseUrl).toContain("localhost");
  });

  it("throws a named-missing error when unset or empty", () => {
    for (const source of [{}, { DATABASE_URL: "" }, { DATABASE_URL: "   " }]) {
      expect(() => loadServerEnv(source)).toThrowError(/SERVER_ENV_MISSING:.*DATABASE_URL/);
    }
  });

  it("throws a named-invalid error for non-postgres schemes", () => {
    for (const url of ["mysql://localhost/db", "file:/tmp/x.db", "sqlite:///x.db", "notaurl"]) {
      expect(() => loadServerEnv({ DATABASE_URL: url })).toThrowError(/SERVER_ENV_INVALID:.*DATABASE_URL/);
    }
  });

  it("never leaks the value (or any part of it) into the error message", () => {
    let message = "";
    try {
      loadServerEnv({ DATABASE_URL: `weird-scheme://${FAKE_SECRET}@host/db` });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(FAKE_SECRET);
    expect(message).not.toContain("host");
    expect(message).not.toContain("weird-scheme");
  });
});
