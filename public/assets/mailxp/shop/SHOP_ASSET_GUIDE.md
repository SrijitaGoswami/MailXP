# MailXP shop art

These assets add real, transparent art for the frontend demo shop. Keep the original MailXP asset pack unchanged.

## Worker outfit sheets

All three files are 1254 × 1254 PNGs, matching the base Worker sheet layout. Use 313 × 313 frames (the final 2 px on each axis are unused): 4 columns × 4 rows. Rows face down, left, right, up; columns are idle A, idle B, walk A, walk B. Keep the same foot anchor and scale as `characters/player/worker.png`.

- `outfits/worker-courier.png` — brick-red courier jacket, cap, teal satchel.
- `outfits/worker-tech.png` — sage utility vest and teal tool pouch.
- `outfits/worker-forest.png` — deep sage cardigan and ochre scarf.

These are full Worker appearance sheets, not NPCs or separate character identities. They can be previewed and equipped as local demo cosmetics. Do not tint the original art to create additional catalog products.

## Decor atlas

`decor/shop-decor.png` is a 1536 × 1024 transparent atlas of eight premium office decorations: trophy, lamp, clock, potted plant, framed art, rug, mug, and mail-bird figurine. Items are arranged conceptually in a 4 × 2 layout, but the image is not guaranteed to have exact equal frame boundaries. Inspect and record actual frame rectangles before extracting or registering them. Preserve alpha and use nearest-neighbor filtering in Phaser.

The expanded decor collection adds 36 more shop candidates in three 1448 × 1086 transparent atlases, arranged as conceptual 4 × 3 grids (362 × 362 source cells):

- `decor/shop-wall-decor.png` — framed art, clocks, plaque, bulletin board, pennant, mirror, mail sorter, and wall sconce.
- `decor/shop-plants-rugs.png` — floor and hanging plants, succulents, rugs, cushions, umbrella stand, and boot tray.
- `decor/shop-desk-lounge.png` — desk organizers, stationery, timer, photo frame, bird figurine, beanbag, lamp, loveseat, footrest, coffee tray, and radio.

These are visual layouts, not pre-extracted Phaser atlases. Inspect every item boundary and create named frames with exact rectangles before using them in the shop or placing them in the office. The conceptual cells provide an initial guide only; keep the original atlas files unchanged.

Shop products must reference real artwork. Keep prices and local demo ownership/equip state in configuration; clearly label all purchases as simulated.
