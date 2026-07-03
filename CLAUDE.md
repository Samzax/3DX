# 3DX — D&D 5e virtual tabletop

Node/Express + Socket.IO server with vanilla-JS ES-module clients (three.js via CDN importmap, no build step).
Run with `npm start` (or `node server.js`), then open http://localhost:3000.

## Routes → files

| Route       | Shell                  | Page module                  | What it is |
|-------------|------------------------|------------------------------|------------|
| `/`         | `public/creator.html`  | `public/js/pages/creator.js` | Character creator (SRD 5.1 rules, 3D preview) |
| `/gm`       | `public/gm.html`       | `public/js/pages/gm.js`      | GM screen: 3-layer map (World→Region→Tactical), object placement, terrain editing |
| `/player`   | `public/player.html`   | `public/js/pages/player.js`  | Player screen: shared map view + character-sheet HUD |
| `/homebrew` | `public/homebrew.html` | `public/js/pages/homebrew.js`| Custom race/class builder |

HTML shells are markup only; each loads its CSS from `public/css/` and one page module.
`public/css/tabletop.css` is shared by gm+player; other CSS files are per-page.

## Shared modules (`public/js/shared/`) — edit here, both screens get the fix

- `scene.js` — three.js scene/camera/lights/plane/grid setup, render loop, pointer raycasting, grid constants + snapping
- `models.js` — token/prop/character meshes (`buildObjectFromData` is the one place synced objects are built), move helper `applyMove`
- `rulers.js` — `RulerTool`: snapping, straight/curved preview, distance tooltip, synced segments
- `ui.js` — long-press submenus, outside-click dismissal
- `login.js` — username modal (player/creator/homebrew; GM auto-logs-in as "GM")
- `srd.js` — SRD data loader + all 5e rules math (AC, HP, spell slots, weapon attacks)
- `terrain.js` — heightmap terrain + material painting + water (GM edits, players view)

`server.js` (~430 lines) is the whole backend: JSON-file persistence + all socket handlers.

## Socket.IO events (the client↔server contract)

- Auth/characters: `login`, `login-success`, `get-characters`, `load-user-characters`, `save-character`, `character-saved-success`, `character-updated`, `delete-character`, `character-deleted`, `update-hp`, `hp-updated`
- Homebrew: `get-homebrew`, `load-homebrew`, `save-homebrew`, `homebrew-saved-success`, `delete-homebrew`
- Maps (scoped by Socket.IO room = map key, e.g. `world/2,-1/0,0`): `join-map`, `map-state`, `add-object`, `object-added`, `move-object`, `object-moved`, `delete-object`, `object-deleted`, `add-ruler`, `ruler-added`, `clear-rulers`, `rulers-cleared`, `update-terrain`, `terrain-updated`

## Conventions & gotchas

- Login is unauthenticated; username "gm" (case-insensitive) gets GM powers. Owner checks are advisory, not a security boundary.
- **`data/srd/*.json` is ~2 MB of vendored SRD 5.1 data — never read those files directly; go through the `srd.js` API.** Attribution in `data/srd/ATTRIBUTION.md`.
- `data/saves/` is runtime state written by the server (characters, map state, homebrew) — gitignored, don't commit it.
- Terrain heights/splat sync as opaque base64 blobs; only clients encode/decode them (`terrain.js`).
- Homebrew is shared content and a stored-XSS surface: escape user text before `innerHTML` (see `escHtml`/`esc` helpers).
- Import maps for three.js must stay inline in the HTML shells (external importmaps aren't supported).
- No tests or linter; verify by running the server and exercising `/gm` + `/player` in a browser.
