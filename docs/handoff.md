# 3DX — Session Handoff (paste this as the first message of a new chat)

Continue working on **3DX**, my D&D 5e virtual tabletop at
`C:\Users\samue\OneDrive\Documentos\code\gdev\Roll30` (Node/Express + Socket.IO,
vanilla-JS ES modules, three.js r132 vendored, no build step). `npm start`, then
`http://localhost:3000` — `/gm`, `/player`, `/` (creator), `/homebrew`.
CLAUDE.md has the conventions. Read `docs/unified-world-design.md`,
`docs/water-v2-design.md`, `docs/chunked-terrain-design.md` for the designs.

## Where the project stands

**Branch state:** `main` has everything through the old U3 "summary blob".
**`lod-terrain` (CURRENT branch, pushed, ahead of main)** replaced that with the
real thing — merge to main only when I approve the look.

Built and working (chronological):
- **Editor UX**: RMB orbit / MMB pan / wheel zoom, camera never locks; brush
  cursor + tactical grid drawn *in the terrain shader* (drape over relief, grid
  fades out beyond ~40u camera distance); undo/redo as copy-on-write chunk
  patches; brushes: raise/lower/smooth/flatten/noise/terrace/ramp/paint/lake/river
  (hotkeys 1–0, `[`/`]` size, Shift inverts, Alt+click eyedropper); hint bar.
- **Chunked infinite terrain**: sparse 32-cell chunks, 0.5u vertex lattice,
  chunk-local geometry (floating-origin safe), streamed window, format-v2
  per-chunk base64 sync, server is a dumb relay.
- **Unified world**: ALL tactical maps are one continuous world (server store
  `@world`); provinces are just camera positions (`provinceWorldCenter`, DMG
  scales Continent 60mi / Kingdom 6mi / Province 1mi, `TIER_WIDTH` in cells =
  63360/6336/1056). Pockets (dungeons) stay separate maps via portals; players
  free-roam via portals.
- **U2 generation**: the whole infinite world is procedurally generated
  (elevation + moisture fields → biomes → heights/materials, seed 1337 in
  `terrain.js`); GM edits override generation; ONLY edits persist/sync.
- **U3 LOD (the current branch's core)**: three clipmap rings (cells 4/16/64u
  out to ±6144u) of lit low-res 3D terrain always under the fine chunks —
  zooming out reveals the world in 3D, no mode switch. Rings sample edited
  chunks too. Holes + dip skirts prevent interpenetration.
- **Real ocean**: `SEA_LEVEL = -0.6` shared by everything — animated water
  shader surface over submerged cells in the window (foam surf line), LOD blue
  beyond, sand beaches above; coastal shelf flattens shores, seabed falls away
  steeply below the waterline. Ocean only on the unified world (pockets dry).
- **Biome-differentiated heights**: plains flat, forests rolling, deserts
  dunes, mountains ridged ~20–27u peaks.
- **Water v2**: poured lakes (priority-flood, can't run to map edge), spline
  rivers (bed carving, waterfalls + mist at steep drops), stylized shader
  (`uBands` uniform for Wind-Waker banding, currently 0).
- Lighting fixed (was 4.5× overexposed → "yellow world"), shadow-acne bias fixed.

## Locked decisions
- Players **free-roam** the world but only receive what the GM reveals →
  U4 = per-player windowed streaming filtered by a GM fog/visibility mask.
- "n+1 hex is a resume of n" = the 3D LOD (not flat colored hexes).
- Hex tiers must become **zoom lenses over the real world** — NOT done yet:
  Continent/Kingdom/Province views still show abstract gray hexes, and the
  biome hex painting is currently a **dead layer** (generator ignores it).

## Next steps, in priority order
1. **Wire the floating-origin rebase** — `Terrain.setWorldOrigin()` exists and
   is tested but nothing calls it; I free-roamed to z≈238,000u where float32
   jitter starts. Rebase when camera target drifts >~4096u from origin.
2. **Hex tiers render the real world** (LOD terrain + hex grid overlay at true
   world positions) + **reconnect biome painting** as generator overrides.
3. **Merge `lod-terrain` → main** once I approve the visuals.
4. **U4**: fog of war + per-player region subscription (`subscribe-region`
   reserved in design doc).
5. Later: props pipeline (Kenney/KayKit CC0 GLTF), pocket playable masks,
   region-scoped terrain reset (global reset is a no-op on `@world` on purpose),
   characters/animations/combat on srd.js, Ghibli visual pass (fog/sky color,
   palette warm-up).

## Known minor issues
- Sparse foam speckle on near-sea-level flats (may read fine in motion).
- Faint seam at the fine-chunk window edge in some light.
- Legacy world map at origin has old-generator terrain baked as edited chunks.

## Critical workflow rules
- Commit as **Samzax <108634046+Samzax@users.noreply.github.com>**; never
  reference Claude in commits/PRs in any way.
- Server on **port 3000** always; if the port is taken it's a stale node
  process serving old code — kill it (this caused a whole "app broken in every
  browser" incident).
- **Visual verification**: screenshots of the preview only update while the
  preview tab is VISIBLE on my screen; hidden tab = stale frames (proven).
  When I say "check", screenshot-verify. On `/gm`, `window.__dbg` exposes
  `{ terrain, scene, camera, controls, plane, grid, renderer, forceRender() }`
  — use it to teleport the camera, bisect meshes, and draw frames while rAF is
  paused. Headless logic tests: `import('/js/shared/terrain.js?cachebust')` in
  preview_eval.
- I sometimes chat remotely — edit the local repo directly, keep the server
  running for my playtests, and verify yourself rather than asking me when the
  preview is visible.
- No tests/linter: verify by running + screenshots + headless evals.
- `data/saves/` is runtime state (gitignored); never read `data/srd/*.json`
  directly (use srd.js).

## Key code map
- `public/js/shared/terrain.js` — everything terrain: generator
  (`genHeightAt/genBiomeAt/genMaterialAt`, `SEA_LEVEL`, coastal shelf), chunks
  + streaming window, LOD rings (`updateLODRings`), ocean (`_rebuildOcean`),
  water bodies (lakes/rivers), undo patches, sync encode/decode,
  `setWorldOrigin` (unwired).
- `public/js/pages/gm.js` — tools/gestures, `updateTerrainLOD` (LOD/fog/grid
  fade per frame), map-state handling (`terrainIsUnified`), `__dbg`.
- `public/js/shared/scene.js` — camera bounds (3–6000), fog, lights,
  `updateWorldFollow`.
- `server.js` — `@world` store + routing, `provinceWorldCenter`, migrations,
  socket handlers (map/objects/terrain/hex/pocket).
