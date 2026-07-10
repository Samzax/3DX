# 3DX — Session Handoff (paste this as the first message of a new chat)

Continue working on **3DX**, my D&D 5e virtual tabletop at
`C:\Users\samue\OneDrive\Documentos\code\gdev\Roll30` (Node/Express + Socket.IO,
vanilla-JS ES modules, three.js r132 vendored, no build step). `npm start`, then
`http://localhost:3000` — `/gm`, `/player`, `/` (creator), `/homebrew`.
CLAUDE.md has the conventions. Design docs: `docs/unified-world-design.md`,
`docs/water-v2-design.md`, `docs/chunked-terrain-design.md`.

## Where the project stands

**Branch state:** everything is on `main`, pushed to GitHub. No side branches.

Built and working (newest first):
- **Tile-brush structures (step 4, v1)**: a new
  Build tool button on the GM toolbar (own panel, tactical maps only).
  `shared/structures.js` builds modular wall runs (drag along grid lines,
  axis-aligned, posts on corners) and floor patches (drag a rectangle; one
  merged mesh, vertex-color checker) from synced object data — ground heights
  are BAKED into the data (`ys` arrays) at creation so GM/player render
  identically; styles stone/wood/plaster; **Scruffy** checkbox = deterministic
  ruins (seeded gaps/crumble/tilt, identical on every client). Ghost preview
  while dragging, Esc cancels, Erase mode / Alt+click deletes a whole
  run/patch. Synced as plain objects (`wall`/`floor` types) through the
  existing add/move/delete events — zero server changes. Walls/floors read as
  GROUND for add/ruler (and for move-drops), so tokens place ON floors; the
  move tool can still grab one when nothing is selected.
- **Pocket-map generator fix** (found while testing the tile brush): since U2,
  `getH`'s generate-on-the-fly fallback leaked procedural-world terrain into
  pocket maps (at the origin that's ocean floor ≈ −3.8, so anything seated via
  `sampleHeight` — tokens included — was buried under the visible flat plane).
  New `terrain.generatorOn` flag: pages set it false on pocket map-state /
  true on unified, gating `genHeightAt`/`genBiomeAt`/`genMaterialAt` to flat-0
  grass. Pockets are flat again; edited chunks still win.
- **Terrain streaming perf**: chunk-window generation, LOD-ring rebuilds and
  the ocean rebuild are all time-sliced/budgeted — teleporting to virgin
  ground costs ~34ms worst frame (was a 6–9 s freeze), pans ~70ms worst /
  14ms median. `_fields` has a one-point memo; rings use revision counters
  (`_lodRev`/`_lodRevAll`) instead of dirty booleans.
- **Seamless zoom**: wheel speed scales log-with-distance (1× close, 4× at
  altitude); the unified world zooms ground → continent ceiling (811008)
  with no 6000u wall (pockets stay capped); player got the zoom-scaled
  camera frustum. Placing/moving an object from a lens altitude flies the
  camera down to it; objects always snap to the fine 1u grid, never hex
  centers (rulers stay hex-aware).
- **Vegetation (step 2 of the visual plan)**: `shared/scatter.js` is a chunked
  deterministic scatter system — world-anchored cached tiles built a few per
  frame under a millisecond budget, packed into InstancedMesh buffers, rim
  fade in the vertex shader (uCenter uniform), matrices cached in world space
  so floating-origin rebases are a repack. `terrain.rev` bumps on any content
  edit; fields clear caches ~350ms after edits settle (paint sand → grass
  dies there). On top of it: **grass** (`shared/grass.js`, two layers — dense
  turf to 12u + sparser 1.35× blades to 55u, root→tip gradient, per-blade
  wind in the shader, camera-distance opacity fades) and **trees**
  (`shared/trees.js`, four procedural low-poly species mixed by biome —
  forest oak/pine, mountain pine, plains/coast sparse, desert bare — with
  shadows, no trees on rock/sand/cliffs/water).
- **Stylized look pass (step 1, partial)**: gradient sky (CanvasTexture,
  horizon stop = SKY_COLOR = fog color so distant terrain melts into the
  sky), hemisphere fill light (was flat ambient), golden sun. Terrain still
  plain Lambert — toon banding/rim light not done.
- Everything from before: unified infinite world (`@world`), hex tiers as
  zoom lenses at true DMG scale, biome painting drives the generator,
  floating origin (rebase >4096u), chunked edited terrain sync, U3 LOD rings,
  real ocean at SEA_LEVEL −0.6, water v2 (poured lakes, spline rivers),
  editor brushes, pockets via portals.

## The agreed visual roadmap (from the "props or brushes?" discussion)

Decided: **no downloaded/prop assets for now — everything procedural**, in
this order. 1 (look pass) is *paused partway*, 2 (grass+trees) is *done*:
1. ~~Stylized look pass~~ — sky/lights in; **remaining dials:** toon/cel
   banding on the terrain material, rim light, horizon warmth, (carefully)
   ACES tone mapping.
2. ~~Grass/vegetation scatter~~ — done (see above).
3. Hand-placed hero props (GLTF pipeline) — **explicitly deferred**, maybe
   permanently.
4. **Tile-brush structures** — the next big feature: Sims-style wall/floor
   painting that emits modular pieces, plus a "scruffy" variant (purposeful
   tilt/jitter) for ruins. Interiors reuse pocket maps via portals.

## Next steps, in priority order
1. ~~Tile-brush structures (step 4)~~ — v1 done (see above). Possible v2
   dials: doors/gaps in runs, per-segment erase, roofs, wall-follow drag
   (L-shapes in one gesture), thicker panel look.
2. Vegetation extras: biome-varied ground cover (desert tufts, forest ferns,
   flowers, rocks), GM density brush (needs a synced channel), tree
   billboards past 220u.
3. Look-pass dials (toon banding, rim light).
4. **U4: fog of war + per-player region subscription** (`subscribe-region`
   reserved in the design doc) — parked, still the plan for player visibility.
5. Later: characters/animations/combat on srd.js, pocket playable masks,
   region-scoped terrain reset.

## Known minor issues
- ~90ms frame for the all-ocean sheet rebuild once per window drain (worst
  case, deep ocean teleport) — fine, but sliceable like the rest if needed.
- Grass far-layer tile builds can hit ~8ms when they fall on off-window
  ground (generator fallback in dominantMaterial/sampleHeight).
- Tree trunk bottoms can peek through on steep dips.
- Sparse foam speckle on near-sea-level flats; faint seam at the fine-chunk
  window edge in some light.
- Legacy world map at origin has old-generator terrain baked as edited chunks.
- Test leftovers from the tile-brush session: a "Build Demo" pocket
  (`pocket/f656e732`, reachable via a portal at the center of tactical
  `world/0,0/0,0/0,0`) holding a sample stone room + wood floor + scruffy
  ruin — walk in to eyeball the tile brush, delete the portal when done.
- `public/js/shared/structures.js` key map entry: wall/floor mesh builders
  (`buildWallRun`/`buildFloorPatch`), seeded `buildRand`, `BUILD_STYLES`,
  `disposeBuiltObject` (ghost cleanup). GM tool logic lives in gm.js
  (`buildBrush`/`buildDrag`/`wallData`/`floorData`/`updateBuildGhost`).

## Critical workflow rules
- Commit as **Samzax <108634046+Samzax@users.noreply.github.com>**; never
  reference Claude in commits/PRs in any way. Commit only when I approve
  (I review screenshots/behavior first, then say "commit").
- Server on **port 3000** always; if the port is taken it's MY playtest
  server running current code — leave it, and use the preview tool's
  auto-assigned port for verification (same files on disk).
- **Visual verification**: screenshots of the preview only update while the
  preview tab is VISIBLE on my screen; hidden tab = stale frames/timeouts.
  When blocked, verify headlessly (counts, timings, pure functions) and ask
  me to eyeball. On `/gm`, `window.__dbg` exposes `{ terrain, scene, camera,
  controls, plane, grid, renderer, worldGroup, forceRender() }`.
- **Test-harness trap:** teleporting `controls.target` more than 4096u in an
  eval triggers a floating-origin rebase — after it, scene coords ≠ world
  coords. Convert via `terrain.worldOrigin` before concluding "the land is
  gone" (this burned a session).
- Headless logic tests: `import('/js/shared/<mod>.js?cachebust')` in
  preview_eval; prototype-patch classes to profile (module instances are
  shared with the page).
- I sometimes chat remotely — edit the local repo directly, keep the server
  running for my playtests.
- No tests/linter: verify by running + screenshots + headless evals.
- `data/saves/` is runtime state (gitignored); never read `data/srd/*.json`
  directly (use srd.js).

## Key code map
- `public/js/shared/terrain.js` — generator (`genHeightAt/genBiomeAt/
  genMaterialAt`, `_fields` memo, `SEA_LEVEL`), chunks + time-sliced
  streaming window (`updateWindow` queue), time-sliced LOD rings
  (`updateLODRings`/`_ringStep`, `_lodRev`), ocean (`_rebuildOcean`, typed
  scratch), water bodies, undo patches, sync encode/decode, `setWorldOrigin`,
  `rev` (edit counter for vegetation).
- `public/js/shared/scatter.js` — `ScatterField` (tile cache, budgeted
  builds, world-space matrices, pack-on-change) + `applyScatterFade` (rim
  fade shader injection).
- `public/js/shared/grass.js` / `trees.js` — vegetation configs on top of
  ScatterField (geometry, wind, colors, fades / species + biome mixing).
- `public/js/shared/scene.js` — gradient sky + `SKY_COLOR`, hemisphere+sun
  lights, camera bounds, floating origin (`maybeRebaseWorld`), grid snap.
- `public/js/pages/gm.js` — tools/gestures, `updateTerrainLOD` (zoom speed,
  frustum, fog, grid fade, vegetation update per frame), `focusCameraOn`
  (descends from lens altitudes), `__dbg`.
- `public/js/pages/player.js` — mirrors gm's updateTerrainLOD (incl. frustum
  scaling); unified maxDistance 811008 / pocket 6000.
- `server.js` — `@world` store + routing, `provinceWorldCenter`, migrations,
  socket handlers (map/objects/terrain/hex/pocket).
