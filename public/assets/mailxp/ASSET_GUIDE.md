# MailXP core asset pack

These are the original transparent PNG source atlases for the MailXP office game. Keep this folder separate from synced `sources/` references. They share a warm cream, teal, walnut, sage, and ochre palette with dark outlines and upper-left lighting.

## Files and dimensions

| File | PNG dimensions | Contents / layout |
|---|---:|---|
| `characters/player/worker.png` | 1254 × 1254 | 4 columns × 4 rows. Columns: idle A, idle B, walk A, walk B. Rows: down, left, right, up. Use 313 × 313 source frames; the last 2 px on each axis are unused. |
| `characters/player/interact-directions.png` | 2172 × 724 | 4 frames in one row, facing down, left, right, up; each frame is 543 × 724. Worker raises a mail envelope. |
| `characters/npcs/office-npcs.png` | 1278 × 1230 | 4 columns × 4 rows. Columns: Officer, Agent, Monkey mascot, Intern. Rows: down, left, right, up. Approximate cell size 319 × 307; 2 px remainder on each axis. |
| `characters/agents/ai-workers.png` | 1774 × 887 | 4 columns × 2 rows. Row 1: Understanding Worker in teal; row 2: Response Worker in amber. Each row shows front, left, right, and back views. Approximate frame size 443 × 443; 2 px horizontal and 1 px vertical remainder. |
| `office/office-props.png` | 1536 × 1024 | Irregularly spaced transparent object atlas: desk, chair, computer, printer, phone, cabinet, bookshelf, sofa, plants, water cooler, notice board, mailboxes, lockers, clock, lamp, wastebasket, mug, parcel, envelope, papers, and DraftCoin. |
| `items/mail-effects.png` | 1536 × 1024 | Irregularly spaced transparent atlas: mail items, DraftCoin, reward token, interaction sparkle/ring, pickup burst, quest-complete burst, and level-up effect. |
| `effects/mail-bird.png` | 1774 × 887 | 4 columns × 2 rows. Top row flies right; bottom row flies left. Columns are wing-flap frames. Approximate frame size 443 × 443; 2 px horizontal and 1 px vertical remainder. |
| `tilesets/office/office-tileset.png` | 1774 × 887 | 16-column × 8-row visual grid of carpet, wood, tile, rug, wall, trim, window, door, and floor-transition pieces. The art is spaced and does not form a strict 32 px Tiled tileset yet. |

All PNGs include an alpha channel. Object/effect art has faint colored glow or shadow pixels around some sprites; preserve alpha and use nearest-neighbor filtering. The character art is high-resolution source art, so scale it down to the game’s chosen pixel size in Phaser.

## Phaser loading

Load the player’s directional animation sheet with:

```ts
this.load.spritesheet('worker', '/assets/mailxp/characters/player/worker.png', {
  frameWidth: 313,
  frameHeight: 313,
});
```

Frame index is `directionRow * 4 + poseColumn`, where direction rows are down, left, right, up; pose columns are idle A/B, walk A/B. For example, walk-down uses frames 2 and 3, and walk-left uses 6 and 7. Enable Phaser's pixel-art rendering (`pixelArt: true`, `roundPixels: true`) and scale the display sprite to the desired world size. The frames contain transparent padding; align the body by its feet and set the sprite origin near the horizontal center and bottom.

Load the interaction poses as a second sheet:

```ts
this.load.spritesheet('worker-interact', '/assets/mailxp/characters/player/interact-directions.png', {
  frameWidth: 543,
  frameHeight: 724,
});
```

Use frame indices 0–3 for down, left, right, and up. Keep the worker’s display size and foot anchor consistent when swapping textures.

## Integration notes

- The NPC file is a directional character atlas. Use the four columns and four rows described above; because the generated image has a 2 px remainder, crop to 319 × 307 frames or make a trimmed Phaser atlas before shipping.
- The AI worker and mail bird sheets are directional/animation source sheets with near-square frames. Crop to 443 × 443 frames (leaving the listed edge remainder) or define trimmed atlas frames before shipping.
- `office-props.png` and `mail-effects.png` are irregular atlases. Load them as images and define named Phaser atlas frames (or split them into individual PNGs) before referring to individual objects in code. Their native dimensions above are exact; no frame rectangles are implied by a regular grid.
- The office tilesheet is a visual source board rather than a strict Tiled-ready 32 × 32 tileset. Cut and normalize selected floor/wall/door pieces into a regular tile atlas before importing it into Tiled or `Tilemap.addTilesetImage`. Do not feed this whole board to a 32 px tilemap as-is.
- This pack covers the requested starter categories and gives a consistent art direction. It is a first production-oriented source pack; collision geometry, map layout, final object frame coordinates, and any final tile normalization belong in the game project’s map/atlas configuration.
- No audio, UI mockups, map screenshot, or project code was added.
