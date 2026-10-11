/**
 * Phase B5 — static guard rails (source scans, no DOM needed).
 *
 * Encodes the two hard frontend invariants of this phase:
 *  1. The Phaser canvas mounts EXACTLY ONCE in AppShell and is never inside
 *     an auth/started conditional — auth transitions are overlay state, so
 *     sign-in/sign-out/session-expiry can never remount OfficeScene.
 *  2. The game runtime (game/**, incl. OfficeScene) contains no live-session
 *     network primitives for auth/state sync — no EventSource, XHR, WebSocket
 *     or sendBeacon anywhere, no fetch in scenes, and nothing in game/ imports
 *     the auth/sync client modules. Server-authoritative sync lives entirely
 *     in the React layer; OfficeScene.update() never awaits the network.
 *     (game/audio/audioManager.ts's boot-time asset override loader is
 *     pre-existing, not session sync — it is asserted to stay OUT of scenes.)
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** Strip comments so prose (e.g. "must not make reads await") can't trip code scans. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

describe("Phaser mount-once guard", () => {
  const shell = read("components/AppShell.tsx");

  it("renders <PhaserCanvas /> exactly once", () => {
    const occurrences = shell.match(/<PhaserCanvas\s*\/>/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it("is never inside a started/auth conditional (no conditional unmount)", () => {
    // The stage div holds it unconditionally; a regression would wrap it like
    // `{started && <PhaserCanvas />}` or `{auth.status === ... && ...}`.
    expect(shell).not.toMatch(/\{[^}]*&&[^}]*<PhaserCanvas/);
    expect(shell).not.toMatch(/\?\s*<PhaserCanvas/);
  });

  it("auth UI lives in overlay branches instead (AuthPanel is rendered)", () => {
    expect(shell).toContain("<AuthPanel");
    expect(shell).toContain("auth.status ===");
  });
});

describe("game runtime has no session/network sync (no polling in the loop)", () => {
  const files = walk("game").filter((file) => !file.endsWith(".test.ts"));

  it("no EventSource / XMLHttpRequest / WebSocket / sendBeacon anywhere in game/", () => {
    const offenders = files.filter((file) =>
      /\b(EventSource|XMLHttpRequest|WebSocket|sendBeacon)\b/.test(read(file)),
    );
    expect(offenders).toEqual([]);
  });

  it("scenes contain no fetch() at all", () => {
    const scenes = files.filter((file) => file.includes("/scenes/"));
    expect(scenes.length).toBeGreaterThan(0);
    const offenders = scenes.filter((file) => /\bfetch\s*\(/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it("nothing in game/ imports the auth/sync client modules or API routes", () => {
    const offenders = files.filter((file) =>
      /from\s+["'].*(apiClient|authStore|useGameSync|AuthPanel|\/api\/v1)/.test(read(file)),
    );
    expect(offenders).toEqual([]);
  });

  it("the profile storage seam stays synchronous (no awaits, no network)", () => {
    const storage = stripComments(read("game/profileStorage.ts"));
    expect(storage).not.toMatch(/\bfetch\s*\(/);
    expect(storage).not.toMatch(/\bawait\b/);
    expect(storage).not.toMatch(/\bEventSource\b/);
  });
});

describe("text inputs stay typable (game keys must not be captured)", () => {
  const scene = read("game/scenes/OfficeScene.ts");

  it("letters W/A/S/D/E are registered WITHOUT capture (addKeys/addKey second arg false)", () => {
    // Phaser defaults enableCapture=true, which globally preventDefaults those
    // letters and made them impossible to type into any input field — a live
    // browser bug fixed in B5. The explicit false must stay.
    expect(scene).toContain('kb.addKeys("W,A,S,D", false)');
    expect(scene).toContain('kb.addKey("E", false)');
  });

  it("arrows/space capture is released while an editable element has focus", () => {
    expect(scene).toContain("disableGlobalCapture()");
    expect(scene).toContain('addEventListener("focusin"');
    expect(scene).toContain('addEventListener("focusout"');
    expect(scene).toContain("enableGlobalCapture()");
  });

  it("resuming play restores capture only when nothing editable is focused", () => {
    const setPaused = scene.slice(scene.indexOf("private setPaused"), scene.indexOf("private setPaused") + 900);
    expect(setPaused).toContain("enableGlobalCapture()");
    expect(setPaused).toContain("isContentEditable");
  });
});

describe("B6 server-authoritative shop (client follows server truth)", () => {
  const shop = read("components/screens/ShopScreen.tsx");
  const shopCode = stripComments(shop);
  const api = read("components/apiClient.ts");
  const sync = read("components/useGameSync.ts");

  it("ShopScreen buys through the purchase API with a fresh Idempotency-Key — never the local purchaseItem()", () => {
    expect(shop).toContain("fetchShopCatalog()");
    expect(shop).toContain("purchaseShopItem(item.id, state.version, crypto.randomUUID())");
    // The legacy local-buy path must stay isolated from the storefront.
    expect(shopCode).not.toMatch(/\bpurchaseItem\(/);
  });

  it("Buy stays disabled until the server catalog (prices/availability) has loaded", () => {
    expect(shop).toContain("const buyDisabled = !catalog || buyingId !== null");
    expect(shop).toContain("disabled={buyDisabled}");
    expect(shop).toContain("(server price)");
  });

  it("rejections resync the balance from the authoritative currentBalance rider", () => {
    expect(shop).toContain("currentBalance");
    expect(shopCode).toContain("patchProfile({ draftCoin: detail.currentBalance })");
    // The success message is only reachable AFTER await purchaseShopItem
    // resolved — nothing optimistic precedes the server confirmation.
    expect(shopCode.indexOf("await purchaseShopItem(")).toBeGreaterThan(-1);
    expect(shopCode.indexOf("Purchased ${item.name}")).toBeGreaterThan(
      shopCode.indexOf("await purchaseShopItem("),
    );
  });

  it("useGameSync refetches authoritative state on economy.updated (contract §5 pointer)", () => {
    expect(sync).toContain('addEventListener("economy.updated"');
  });

  it("apiClient sends the Idempotency-Key header for purchases and the dev fixture", () => {
    expect(api).toContain('"Idempotency-Key": idempotencyKey');
    expect(api).toContain("/api/v1/shop/purchases");
    expect(api).toContain("/api/v1/dev/rewards");
  });
});
