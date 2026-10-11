/**
 * Cross-scene flow control.
 *
 * PreloadScene starts `flow.afterPreload` once loading finishes. createGame
 * sets it per mount: "Office" for the normal game flow (Phase 7 boots straight
 * into the office — the React title overlay sits on top of the live scene),
 * "AssetPreview" for the /preview route — so the preview scene can never
 * start inside the game flow (and Office is not even registered there).
 */
export const flow: { afterPreload: string } = {
  afterPreload: "Office",
};
