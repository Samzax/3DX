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
- **U4: Fog of war (per-player reveal)**: players free-roam the camera but the
  server only SENDS them content inside GM-revealed regions. The mask is a set
  of hexes on a **global province-pitch lattice** (1-mile cells, centered on
  the world origin — deliberately not the nested navigation lattice, which
  re-ids the same ground under different parents); it persists at
  `maps['@world'].fog`. `shared/fog.js` holds the client half: `FogMask`,
  brush helpers, and `FogOverlay` — ONE dark sheet at y=80 with holes punched
  for revealed hexes (hidden ground is the infinite default, so per-hidden-hex
  tiles can't work at survey zoom), rebuilt only when mask/center-bucket/zoom-
  bucket change. Server (`update-fog` → `fog-updated` global broadcast, like
  hex-updated): filters `map-state` objects+terrain chunks for non-GM sockets
  on unified rooms, per-socket emits for add/move/terrain
  (`emitToRoom`/`objectVisibleTo`), boundary crossings emit
  object-added/deleted, reveals push the uncovered chunks, hides rely on the
  client dropping its own chunks (`fog-updated` handler in player.js). Own
  characters are always visible to their owner; pockets are never fogged;
  chunks classify by center (`chunkFogHexKey`, identical both sides). GM: Fog
  tool button + panel (Reveal/Hide, radius 0–6 hexes), drag-paints at any
  zoom, sees a 0.45-opacity preview sheet while the tool is active; players
  get a 0.94-opacity sheet always. `fogHexKeyAt` math MUST stay bit-identical
  between server.js and shared/fog.js. Login re-sends map-state (the pre-login
  auto-join snapshot was filtered as anonymous). Default is ALL HIDDEN — a
  fresh player sees darkness until the GM reveals.
- **Combat mode (server-authoritative 5e fights)**: `shared/combat.js` holds
  the client pieces — `deriveCombatStats` (SRD→combatant numbers, same math as
  the player HUD sheet), `CombatTracker` (initiative list + combat log UI) and
  `CombatOverlays` (turn ring, movement-range ring, effect badges in
  `worldGroup`). The **server rolls all dice** and enforces turns, actions and
  movement (`server.js` grew to ~1040 lines and now owns rules, not just
  persistence): actions are `attack` / `dash` / `dodge` / `disengage`; auto
  effects expire at the start of the combatant's next turn; GM can hand out
  conditions (prone, poisoned, restrained, …) from the tracker. Events:
  `combat-start/-end/-set-stats/-roll-initiative/-begin/-action/-end-turn/
  -set-turn/-update-combatant/-set-order/-remove-combatant/-add-combatant/
  -effect` → `combat-updated` (full state or null), `combat-log`,
  `combat-denied` (offender only — never reuse `error`, the player client
  routes that to the login modal). Combat state lives on the room key, so a
  tactical fight is stored on `@world` = **one combat at a time outside
  pockets**. The server never loads SRD data: clients answer `statsPending`
  character combatants via `combat-set-stats` (first write wins, GM edits
  always win; the GM client can answer for every character since it has them
  all + homebrew). GM screen: combat toggle button, tracker panel,
  click-to-target attacks, live «X ft — Y ft left» move tooltip; player screen
  mirrors state and offers own-turn actions. Damage/healing on character
  combatants syncs back to the saved character's HP.
- **Shared character models in the creator**: the creator preview now renders
  the exact model the tabletop shows (`models.js` `createCharacterModel` +
  `disposeModel`), same scale, rebuilt+disposed on every slider tweak — race
  features and equipment stay in sync between preview and table.
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
1. ~~Combat mode~~ — v1 done (see above). Possible v2 dials: opportunity
   attacks, advantage/disadvantage from conditions, saving-throw actions,
   spell attacks/slots in combat, death saves, multi-target/AoE.
2. ~~U4: fog of war~~ — v1 done (see above). Possible v2 dials: fog sheet
   look (soft edges / cloud texture instead of the flat dark plane),
   auto-reveal around player tokens, per-player masks (now it's one shared
   mask), rulers/water filtering, `subscribe-region` streaming when world
   size demands it.
3. Tile-brush v2 dials: doors/gaps in runs, per-segment erase, roofs,
   wall-follow drag (L-shapes in one gesture), thicker panel look.
4. Vegetation extras: biome-varied ground cover (desert tufts, forest ferns,
   flowers, rocks), GM density brush (needs a synced channel), tree
   billboards past 220u.
5. Look-pass dials (toon banding, rim light).
6. Later: character animations, pocket playable masks, region-scoped terrain
   reset.

## Known minor issues
- ~90ms frame for the all-ocean sheet rebuild once per window drain (worst
  case, deep ocean teleport) — fine, but sliceable like the rest if needed.
- Grass far-layer tile builds can hit ~8ms when they fall on off-window
  ground (generator fallback in dominantMaterial/sampleHeight).
- Tree trunk bottoms can peek through on steep dips.
- Sparse foam speckle on near-sea-level flats; faint seam at the fine-chunk
  window edge in some light.
- Legacy world map at origin has old-generator terrain baked as edited chunks.
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
  controls, plane, grid, renderer, worldGroup, fogMask, socket,
  forceRender() }`.
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
- `public/js/shared/combat.js` — `deriveCombatStats`, `CombatTracker`
  (tracker + log UI), `CombatOverlays` (rings/badges), `EFFECTS`,
  `remainingFeet`.
- `public/js/shared/models.js` — `buildObjectFromData` (the one place synced
  objects are built), `createCharacterModel`/`disposeModel` (shared with the
  creator preview), move helper `applyMove`.
- `public/js/pages/gm.js` — tools/gestures, `updateTerrainLOD` (zoom speed,
  frustum, fog, grid fade, vegetation update per frame), `focusCameraOn`
  (descends from lens altitudes), combat wiring (`setCombat`, `pendingAttack`
  click-to-target, `answerStatsPending`), `__dbg`.
- `public/js/pages/player.js` — mirrors gm's updateTerrainLOD (incl. frustum
  scaling); unified maxDistance 811008 / pocket 6000; combat panel +
  own-turn actions; fog mask/overlay + `fog-updated` chunk-drop.
- `public/js/shared/fog.js` — U4 fog of war: global province-pitch lattice
  (`fogHexKeyAt`, bit-identical to server.js), `FogMask`, `FogOverlay`
  (holes-in-a-sheet), `hexesWithin` (GM brush).
- `server.js` (~1215 lines) — `@world` store + routing, `provinceWorldCenter`,
  migrations, socket handlers (map/objects/terrain/hex/pocket/fog), fog
  filtering (`objectVisibleTo`/`filterTerrainForPlayer`/`emitToRoom`) **and
  the whole combat rules engine** (dice, turn order, action/movement
  enforcement, condition expiry, HP write-back to characters).
