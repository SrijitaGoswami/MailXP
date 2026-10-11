/**
 * Phase B2 — persistence-seam round-trip tests.
 *
 * Prove the ProfileStorage adapter refactor changed NOTHING observable:
 * defaults, save/load, legacy mailxp.profile.v1 data, malformed data and
 * every persisted field behave exactly as the pre-B2 module did — including
 * the SSR (no-window) path, storage failures, and the economy helpers.
 *
 * Each test re-imports the module (vi.resetModules) so module-level
 * `cached`/listeners start fresh, exactly like a real page reload.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProfileStorage, type ProfileStorage } from "./profileStorage";

const STORAGE_KEY = "mailxp.profile.v1";

type ProfileModule = typeof import("./profile");

interface FakeLocalStorage {
  map: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

function makeFakeStorage(): FakeLocalStorage {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => void map.clear(),
  };
}

let fake: FakeLocalStorage;

function stubWindow(storage: FakeLocalStorage = fake): void {
  (globalThis as Record<string, unknown>).window = { localStorage: storage };
}

function removeWindow(): void {
  delete (globalThis as Record<string, unknown>).window;
}

async function loadProfile(): Promise<ProfileModule> {
  vi.resetModules();
  return import("./profile");
}

function stored(): Record<string, unknown> | null {
  const raw = fake.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

beforeEach(() => {
  fake = makeFakeStorage();
  stubWindow();
});

afterEach(() => {
  removeWindow();
});

// ------------------------------------------------------------------ defaults --

describe("defaults", () => {
  it("returns pristine defaults when nothing is stored", async () => {
    const p = await loadProfile();
    const profile = p.getProfile();
    expect(profile.version).toBe(1);
    expect(profile.draftCoin).toBe(p.getDefaultProfile().draftCoin);
    expect(profile.ownedItems).toEqual([]);
    expect(profile.equippedOutfit).toBe("worker");
    expect(profile.placedDecor).toEqual([]);
    expect(profile.prefs).toEqual(p.getDefaultProfile().prefs);
  });

  it("does not write anything just by reading", async () => {
    const p = await loadProfile();
    p.getProfile();
    expect(fake.map.size).toBe(0);
  });

  it("getDefaultProfile is frozen and stable across calls", async () => {
    const p = await loadProfile();
    expect(p.getDefaultProfile()).toBe(p.getDefaultProfile());
    expect(Object.isFrozen(p.getDefaultProfile())).toBe(true);
    expect(Object.isFrozen((p.getDefaultProfile() as { prefs: unknown }).prefs)).toBe(true);
  });
});

// ---------------------------------------------------------------- round-trip --

describe("save/load round-trip", () => {
  it("persists every persisted field and reloads it identically", async () => {
    const p = await loadProfile();
    p.patchProfile({
      draftCoin: 123,
      ownedItems: ["art-mountain", "outfit-courier"],
      equippedOutfit: "courier",
      placedDecor: [{ itemId: "art-mountain", x: 592, y: 368 }],
      prefs: { masterVolume: 0.5, muted: true, motion: "reduced", touchControls: "on" },
    });

    const onDisk = stored();
    expect(onDisk).not.toBeNull();
    expect(onDisk?.draftCoin).toBe(123);
    expect(onDisk?.ownedItems).toEqual(["art-mountain", "outfit-courier"]);
    expect(onDisk?.equippedOutfit).toBe("courier");
    expect(onDisk?.placedDecor).toEqual([{ itemId: "art-mountain", x: 592, y: 368 }]);
    expect((onDisk?.prefs as Record<string, unknown>).masterVolume).toBe(0.5);
    expect((onDisk?.prefs as Record<string, unknown>).muted).toBe(true);
    expect((onDisk?.prefs as Record<string, unknown>).motion).toBe("reduced");
    expect((onDisk?.prefs as Record<string, unknown>).touchControls).toBe("on");

    // Simulated reload: fresh module reads the same bytes back.
    const reloaded = await loadProfile();
    expect(reloaded.getProfile()).toEqual(p.getProfile());
  });

  it("merges prefs patches instead of replacing the prefs object", async () => {
    const p = await loadProfile();
    p.patchProfile({ prefs: { uiVolume: 0.3 } });
    const profile = p.getProfile();
    expect(profile.prefs.uiVolume).toBe(0.3);
    expect(profile.prefs.masterVolume).toBe(p.getDefaultProfile().prefs.masterVolume);
    expect(profile.prefs.gameVolume).toBe(p.getDefaultProfile().prefs.gameVolume);
  });
});

// --------------------------------------------------------------- legacy data --

describe("legacy mailxp.profile.v1 data", () => {
  it("loads a pre-B2 saved profile unchanged", async () => {
    fake.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        draftCoin: 840,
        ownedItems: ["outfit-tech", "plant-small"],
        equippedOutfit: "tech",
        placedDecor: [
          { itemId: "plant-small", x: 120, y: 300 },
          { itemId: "outfit-tech", x: 0, y: 0 },
        ],
        prefs: {
          masterVolume: 0.6,
          uiVolume: 0.7,
          gameVolume: 0.65,
          muted: false,
          motion: "full",
          touchControls: "auto",
        },
      }),
    );
    const p = await loadProfile();
    const profile = p.getProfile();
    expect(profile.draftCoin).toBe(840);
    expect(profile.ownedItems).toEqual(["outfit-tech", "plant-small"]);
    expect(profile.equippedOutfit).toBe("tech");
    expect(profile.placedDecor).toHaveLength(2);
    expect(profile.prefs.gameVolume).toBe(0.65);
  });
});

// ------------------------------------------------------------ malformed data --

describe("malformed data is no worse than baseline (sanitised per field)", () => {
  async function loadWith(raw: unknown): Promise<ProfileModule> {
    fake.setItem(STORAGE_KEY, JSON.stringify(raw));
    return loadProfile();
  }

  it("falls back to defaults for corrupt JSON", async () => {
    fake.setItem(STORAGE_KEY, "{definitely not json");
    const p = await loadProfile();
    expect(p.getProfile()).toEqual(p.getDefaultProfile() as unknown as ReturnType<typeof p.getProfile>);
  });

  it("falls back to defaults for non-object JSON", async () => {
    for (const raw of ['5', '"hello"', "null", "true", "[1,2]"]) {
      fake.setItem(STORAGE_KEY, raw);
      const p = await loadProfile();
      expect(p.getProfile().draftCoin).toBe(p.getDefaultProfile().draftCoin);
      expect(p.getProfile().equippedOutfit).toBe("worker");
    }
  });

  it("sanitises each field of a partially-broken profile", async () => {
    const p = await loadWith({
      version: 99, // ignored — always normalised to 1
      draftCoin: -50, // invalid -> default
      ownedItems: ["ok-item", 42, null, { x: 1 }], // non-strings dropped
      equippedOutfit: "hacker", // invalid -> worker
      placedDecor: [
        { itemId: "art-good", x: 10, y: 20 }, // valid -> kept
        { itemId: 42, x: 1, y: 2 }, // bad itemId -> dropped
        { itemId: "art-bad", x: "no", y: 2 }, // bad x -> dropped
        null, // dropped
      ],
      prefs: {
        masterVolume: "loud", // invalid -> default
        uiVolume: 3, // clamped -> 1
        gameVolume: -1, // clamped -> 0
        muted: "yes", // invalid -> default false
        motion: "chaotic", // invalid -> full
        touchControls: "maybe", // invalid -> auto
      },
    });
    const profile = p.getProfile();
    expect(profile.version).toBe(1);
    expect(profile.draftCoin).toBe(p.getDefaultProfile().draftCoin);
    expect(profile.ownedItems).toEqual(["ok-item"]);
    expect(profile.equippedOutfit).toBe("worker");
    expect(profile.placedDecor).toEqual([{ itemId: "art-good", x: 10, y: 20 }]);
    expect(profile.prefs.masterVolume).toBe(p.getDefaultProfile().prefs.masterVolume);
    expect(profile.prefs.uiVolume).toBe(1);
    expect(profile.prefs.gameVolume).toBe(0);
    expect(profile.prefs.muted).toBe(false);
    expect(profile.prefs.motion).toBe("full");
    expect(profile.prefs.touchControls).toBe("auto");
  });

  it("floors fractional but valid balances", async () => {
    const p = await loadWith({ draftCoin: 33.9 });
    expect(p.getProfile().draftCoin).toBe(33);
  });
});

// ------------------------------------------------------------------- economy --

describe("economy helpers (unchanged behaviour)", () => {
  it("addDraftCoin never goes below zero", async () => {
    const p = await loadProfile();
    p.addDraftCoin(-10_000);
    expect(p.getProfile().draftCoin).toBe(0);
    p.addDraftCoin(50);
    expect(p.getProfile().draftCoin).toBe(50);
  });

  it("spendDraftCoin guards the balance", async () => {
    const p = await loadProfile();
    p.patchProfile({ draftCoin: 10 });
    expect(p.spendDraftCoin(20)).toBe(false);
    expect(p.getProfile().draftCoin).toBe(10);
    expect(p.spendDraftCoin(10)).toBe(true);
    expect(p.getProfile().draftCoin).toBe(0);
  });

  it("purchaseItem covers ok / owned / insufficient", async () => {
    const p = await loadProfile();
    p.patchProfile({ draftCoin: 100 });
    expect(p.purchaseItem("plant-small", 60)).toBe("ok");
    expect(p.getProfile().draftCoin).toBe(40);
    expect(p.getProfile().ownedItems).toEqual(["plant-small"]);
    expect(p.purchaseItem("plant-small", 60)).toBe("owned");
    expect(p.purchaseItem("art-mountain", 999)).toBe("insufficient");
    expect(p.getProfile().draftCoin).toBe(40);
  });

  it("ownsItem treats the base worker outfit as implicit", async () => {
    const p = await loadProfile();
    expect(p.ownsItem("worker")).toBe(true);
    expect(p.ownsItem("anything-else")).toBe(false);
  });

  it("resetProfile restores every persisted field", async () => {
    const p = await loadProfile();
    p.patchProfile({
      draftCoin: 999,
      ownedItems: ["x"],
      equippedOutfit: "forest",
      placedDecor: [{ itemId: "x", x: 1, y: 2 }],
      prefs: { muted: true },
    });
    p.resetProfile();
    expect(p.getProfile()).toEqual(p.getDefaultProfile() as unknown as ReturnType<typeof p.getProfile>);
    expect(stored()?.draftCoin).toBe(p.getDefaultProfile().draftCoin);
  });
});

// --------------------------------------------------------------- subscribers --

describe("subscribers", () => {
  it("notifies on patch and stops after unsubscribe (idempotent)", async () => {
    const p = await loadProfile();
    const seen: number[] = [];
    const unsub = p.subscribeProfile((profile) => seen.push(profile.draftCoin));
    p.patchProfile({ draftCoin: 1 });
    p.addDraftCoin(1);
    expect(seen).toEqual([1, 2]);
    unsub();
    unsub(); // idempotent
    p.addDraftCoin(1);
    expect(seen).toEqual([1, 2]);
  });
});

// ------------------------------------------------------- SSR and storage fails --

describe("SSR (no window) and storage failures", () => {
  it("returns defaults without a window and never throws", async () => {
    removeWindow();
    const p = await loadProfile();
    expect(p.getProfile()).toEqual(p.getDefaultProfile() as unknown as ReturnType<typeof p.getProfile>);
    expect(() => p.patchProfile({ draftCoin: 5 })).not.toThrow();
    expect(p.getProfile().draftCoin).toBe(5); // in-memory still works
  });

  it("keeps the session in-memory when setItem throws (quota/blocked)", async () => {
    const p = await loadProfile();
    fake.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => p.patchProfile({ draftCoin: 77 })).not.toThrow();
    expect(p.getProfile().draftCoin).toBe(77);
  });
});

// ---------------------------------------------------------- adapter behaviour --

describe("ProfileStorage adapter seam", () => {
  it("defaults to the localStorage adapter", async () => {
    await loadProfile();
    expect(getProfileStorage().kind).toBe("local");
  });

  it("routes reads and writes through an injected adapter (B5 swap preview)", async () => {
    // Load profile first (resets the registry), then import the adapter module
    // from the SAME registry generation that profile.ts is using.
    const p = await loadProfile();
    const storage = await import("./profileStorage");
    const backing = new Map<string, string>();
    let writes = 0;
    const memoryAdapter: ProfileStorage = {
      kind: "local",
      read: () => {
        const serialized = backing.get("profile");
        return serialized ? (JSON.parse(serialized) as unknown) : null; // parsed, per the ProfileStorage contract
      },
      write: (profile) => {
        writes += 1;
        backing.set("profile", JSON.stringify(profile));
      },
    };
    const restore = storage.setProfileStorage(memoryAdapter);
    expect(storage.getProfileStorage()).toBe(memoryAdapter);

    // Writes go to the injected adapter, not localStorage.
    p.patchProfile({ draftCoin: 321, equippedOutfit: "forest" });
    expect(writes).toBe(1);
    expect(fake.map.size).toBe(0); // untouched
    expect(backing.has("profile")).toBe(true);

    // A fresh module load reads through the (module-level) adapter again —
    // re-inject after resetModules, as a real integration would at boot.
    const reloaded = await loadProfile();
    const storage2 = await import("./profileStorage");
    storage2.setProfileStorage(memoryAdapter);
    expect(reloaded.getProfile().draftCoin).toBe(321);
    expect(reloaded.getProfile().equippedOutfit).toBe("forest");

    restore();
    expect(storage.getProfileStorage().kind).toBe("local");
  });
});
