"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";

import { playSound } from "../game/audio/audioManager";
import CharacterScreen from "./screens/CharacterScreen";
import InboxScreen from "./screens/InboxScreen";
import InventoryScreen from "./screens/InventoryScreen";
import RewardsScreen from "./screens/RewardsScreen";
import SettingsScreen from "./screens/SettingsScreen";
import ShopScreen from "./screens/ShopScreen";
import QuestPanels from "./QuestPanels";

/**
 * Phase 7 — the in-game menu: a side panel that OVERLAYS the live game.
 *
 * Replaces the page-level tab strip. The panel holds the same six sections
 * (Tasks, Character, Inventory, Shop, Rewards, Settings) as a vertical ARIA
 * tablist with roving tabindex (Arrow/Home/End keys), reusing the existing
 * screens' interiors unchanged. All sections stay mounted and are toggled
 * with `hidden`, so the Phaser canvas underneath never unmounts and in-progress
 * state (reply drafts, panel scroll) survives navigation.
 *
 * Accessibility contract:
 * - `role="dialog" aria-modal="true"` with focus moved in on open and returned
 *   to the Menu button by AppShell on close.
 * - Escape closes (document-level listener while open).
 * - While open, AppShell has paused the game via the bridge, so stray key or
 *   pad input can never reach gameplay.
 */
export const MENU_SECTIONS = [
  { id: "tasks", label: "Tasks" },
  { id: "inbox", label: "Inbox" },
  { id: "character", label: "Character" },
  { id: "inventory", label: "Inventory" },
  { id: "shop", label: "Shop" },
  { id: "rewards", label: "Rewards" },
  { id: "settings", label: "Settings" },
] as const;

export type MenuSection = (typeof MENU_SECTIONS)[number]["id"];

export default function GameMenu({
  open,
  section,
  onSectionChange,
  onClose,
}: {
  open: boolean;
  section: MenuSection;
  onSectionChange: (next: MenuSection) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Move focus into the dialog whenever it opens.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  // Escape closes the menu from anywhere inside it.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  function activate(next: MenuSection): void {
    if (next === section) return;
    playSound("ui-nav");
    onSectionChange(next);
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const index = MENU_SECTIONS.findIndex((entry) => entry.id === section);
    let next = -1;
    if (event.key === "ArrowDown") next = (index + 1) % MENU_SECTIONS.length;
    else if (event.key === "ArrowUp") next = (index - 1 + MENU_SECTIONS.length) % MENU_SECTIONS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = MENU_SECTIONS.length - 1;
    if (next < 0) return;
    event.preventDefault();
    activate(MENU_SECTIONS[next].id);
    tabRefs.current[next]?.focus();
  }

  function renderSection(id: MenuSection): React.ReactNode {
    switch (id) {
      case "tasks":
        return <QuestPanels />;
      case "inbox":
        return <InboxScreen />;
      case "character":
        return <CharacterScreen onGoShop={() => activate("shop")} />;
      case "inventory":
        return (
          <InventoryScreen
            onGoShop={() => activate("shop")}
            onGoCharacter={() => activate("character")}
            // Placement happens on the visible map — close the panel so the
            // player can see (and tap) the spot they are placing on.
            onStartPlacement={onClose}
          />
        );
      case "shop":
        return (
          <ShopScreen
            onGoInventory={() => activate("inventory")}
            onGoCharacter={() => activate("character")}
            onStartPlacement={onClose}
          />
        );
      case "rewards":
        return <RewardsScreen />;
      case "settings":
        return <SettingsScreen />;
    }
  }

  if (!open) return null;

  return (
    <>
      {/* Dimmed backdrop: click to close; also blocks pointer input to the game. */}
      <div
        className="absolute inset-0 z-30 bg-black/50"
        aria-hidden="true"
        onClick={onClose}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Game menu"
        tabIndex={-1}
        onKeyDown={(event) => {
          // Safety net: if focus ever escapes to the dialog container itself,
          // keep Tab cycling inside (the six tabs + close button are enough).
          if (event.key === "Tab" && event.target === event.currentTarget) {
            event.preventDefault();
            tabRefs.current[MENU_SECTIONS.findIndex((entry) => entry.id === section)]?.focus();
          }
        }}
        className="absolute right-0 top-0 z-40 flex h-full w-full max-w-[440px] flex-col border-l-4 border-[var(--mailxp-walnut)] bg-[var(--mailxp-cream)] shadow-2xl"
      >
        <header className="flex items-center justify-between border-b-2 border-[var(--mailxp-walnut)]/40 px-4 py-3">
          <h2 className="text-lg font-black tracking-tight text-[var(--mailxp-teal)]">Menu</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="rounded border-2 border-[var(--mailxp-walnut)] px-3 py-1 text-sm font-bold transition hover:bg-white/70"
          >
            ✕
          </button>
        </header>

        {/* Vertical tablist — one entry per section. */}
        <div
          role="tablist"
          aria-label="Menu sections"
          aria-orientation="vertical"
          onKeyDown={onTabKeyDown}
          className="flex flex-col gap-1 border-b-2 border-[var(--mailxp-walnut)]/40 p-2"
        >
          {MENU_SECTIONS.map((entry, index) => {
            const active = section === entry.id;
            return (
              <button
                key={entry.id}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                type="button"
                role="tab"
                id={`menu-tab-${entry.id}`}
                aria-selected={active}
                aria-controls={`menu-panel-${entry.id}`}
                tabIndex={active ? 0 : -1}
                onClick={() => activate(entry.id)}
                className={`rounded px-3 py-2 text-left text-sm font-semibold transition ${
                  active
                    ? "bg-[var(--mailxp-teal)] text-white shadow"
                    : "text-[var(--mailxp-walnut)] hover:bg-white/70"
                }`}
              >
                {entry.label}
              </button>
            );
          })}
        </div>

        {/* Sections: all mounted, toggled with `hidden` (canvas never resets
            and in-progress state — like a half-edited reply — survives). */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          {MENU_SECTIONS.map((entry) => (
            <div
              key={entry.id}
              role="tabpanel"
              id={`menu-panel-${entry.id}`}
              aria-labelledby={`menu-tab-${entry.id}`}
              tabIndex={0}
              hidden={section !== entry.id}
              className="outline-none"
            >
              {renderSection(entry.id)}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
