# Water v2 — Design

> **Status (2026-07):** implemented (poured lakes + spline rivers are live).
> Kept as the reference for the data model and the pour algorithm.

Goal: water that **looks** like water (stylized, animated, Ghibli-leaning) and
**behaves** like water (fills the valley you pour it into, stops at ridges,
reacts when you sculpt under it) — without the failure of v0 (full simulation
running off to the map edge) or of v1 (a static global-level sheet).

The core idea: **authored intent, physical settling**. The GM places *water
bodies* (a lake here, a river there); each body computes its own footprint from
the terrain with a bounded, deterministic algorithm. No global level, no free
simulation, no way to flood the world by accident — but sculpt a trench into a
lake's rim and the water *will* pour into it, because the footprint re-settles.

## 1. Data model (replaces the global `{enabled, level}`)

```json
"water": {
  "bodies": [
    { "id": "w1", "kind": "lake",
      "seed": { "x": 12.5, "z": -30 },      // where the GM clicked ("pour point")
      "level": 3.2,                          // requested water level (world Y)
      "maxRadius": 96 },                     // fill containment (world units)
    { "id": "w2", "kind": "river",
      "points": [ { "x": 0, "z": 0 }, { "x": 8, "z": 14 }, ... ],  // waypoints
      "width": 2.5, "speed": 1.0, "carve": 0.6 }
  ]
}
```

- Stored inside `map.terrain.water` (same place as today) — the server stays a
  dumb relay; only the shape of the field changes.
- **Tiny sync payloads**: a lake is ~5 numbers. The *footprint is never synced* —
  every client recomputes it deterministically from the body params + the
  quantized heights it already has. Same inputs → same water on every screen.
- Terrain edits under a body trigger a local recompute on all clients (they all
  received the same chunk delta), so water reacts to sculpting with zero extra
  network traffic.
- Migration: if a map still has old `{enabled: true, level}` water, convert to
  one lake body seeded at the lowest vertex of its existing chunks.

## 2. Lake fill — the "pour" algorithm (why it can't run to the map edge)

Priority-flood ("pour water at a point"), run on the cell-corner lattice within
`maxRadius` of the seed:

```
heap  <- { seed cell, priority = terrain height }
spill <- -inf
while heap not empty:
    cell = pop lowest
    spill = max(spill, height(cell))         // level needed to have reached here
    if spill > requestedLevel: break          // basin holds it: done
    if dist(cell, seed) >= maxRadius:         // basin leaks past containment:
        requestedLevel = spill - epsilon      //   clamp to the leak's lip
        break
    mark cell as flooded at level `spill`
    push unvisited neighbors
footprint = flooded cells with floodLevel <= finalLevel
```

Properties:
- Water fills **exactly the connected basin** under the click, up to the level
  you asked for — or up to the basin's natural **spill point** if you asked for
  more than it can hold. Overfill doesn't escape; it just tells you the lip height.
- `maxRadius` (default 96 u, adjustable per body) is the hard containment for
  basins that are genuinely open (e.g. flat default ground) — the failure mode
  of v0 becomes a clamped, visible boundary instead of a world flood.
- Cost: O(n log n) over ≤ ~37k cells at default radius — a few ms, only on
  body edit or terrain change under the body (footprint bbox test).
- Deterministic: runs on the Int16-quantized heights that all clients share.

**Sculpt interactions** (this is the "behaves like water" payoff):
- Dig the shore deeper → lake expands into the new hollow on stroke end.
- Raise a causeway through it → the far side dries (no longer reachable from
  the seed) — or stays if you place a second lake body there.
- Dig below a lake's rim toward a valley → water pours through the cut and
  fills the valley up to the shared level. All from the same fill, no sim.

## 3. Rivers — authored splines that respect the terrain

- GM clicks waypoints; Catmull-Rom spline through them, sampled every ~1 u.
- The ribbon mesh (width `width`) drapes on the terrain: each sample takes
  `terrainHeight + 0.05`, banked flat. Flow direction = point order; `speed`
  scales the flow animation.
- `carve` (optional, default on): lower the terrain under the ribbon by up to
  `carve` units with smooth falloff — one reusable call to the existing
  `Terrain.ramp`-style stamping, applied once when the river is created/edited
  (and undoable like any stroke). This guarantees the river sits *in* a bed
  instead of floating over bumps.
- Where consecutive samples drop steeply (> ~1.5 u per sample), the ribbon
  section becomes a **waterfall**: stretched UV, whiter color, and a small
  mist sprite at the base (we had this in the old branch; the recipe ports).
- A river endpoint inside a lake footprint snaps its height to the lake level
  over the last few samples, so rivers visually *feed* lakes.

## 4. Rendering — one stylized shader, two mesh kinds

One custom `THREE.ShaderMaterial` shared by all water meshes (r132-friendly,
no external textures — all noise is procedural in-shader):

**Per-vertex attributes** (computed at mesh build, no depth-buffer tricks):
- `aDepth` — water depth at that vertex (`level - terrainHeight`, sampled from
  the heightmap we already have). This drives everything shore-related.
- `aFlow` — river only: UV.x along the spline (flow coordinate), 0 for lakes.

**Fragment recipe** (each step is cheap and independently tunable):
1. **Depth tint**: `mix(shallowColor, deepColor, 1 - exp(-aDepth * k))` —
   glassy teal at the shore, saturated blue in the middle. Alpha ramps the
   same way (shallow water is more transparent).
2. **Foam contact line**: `aDepth < foamWidth` → foam, with the threshold
   wobbled by scrolling 2-octave value noise so the shoreline breathes.
   This single feature is ~70% of the stylized-water read.
3. **Surface motion**: two scrolling noise octaves perturb a fake normal;
   `pow(max(dot(N, sunDir), 0), shininess)` gives moving sun glints. Lakes
   scroll slowly in world XZ; rivers scroll along `aFlow` at `speed` (foam
   streaks elongated along flow).
4. **Fresnel-ish rim**: brighten + opacify at grazing view angles
   (`1 - dot(viewDir, up)`) so distant water reads solid, near water reads clear.
5. **Stylization switch**: depth tint quantized to 3 bands + foam edge held
   crisp = the Ghibli/Wind-Waker look; a uniform lets us blend between smooth
   and banded until you pick by eye.

**Meshes**:
- **Lake surface**: one mesh per lake — quads over footprint cells at `level`
  (like today's builder, plus the `aDepth` attribute and skirt quads at the
  shore so the waterline meets terrain without gaps). Rebuilt only when its
  body or the terrain under it changes; chunk streaming does not affect it
  (water bodies are small relative to the world).
- **River ribbon**: one mesh per river, rebuilt on waypoint/terrain change.
- Both animate purely via a `uTime` uniform — zero per-frame CPU work.

## 5. UI (terrain panel "Water" section replaces the toggle+slider)

- **Lake tool**: click terrain → pours a lake at that point at
  `clickHeight + 1`; drag up/down before release to set the level live
  (footprint preview updates as you drag). Click an existing lake → re-drag
  its level. Alt+click a lake → delete.
- **River tool**: click waypoints; Enter/double-click finishes, Esc cancels;
  width comes from the brush radius slider, `carve` toggle in the panel.
- Body list in the panel (name, kind, level) with delete buttons — the map is
  the primary UI, the list is the fallback.
- All water ops push onto the existing undo stack (body-diff entries alongside
  the chunk-patch entries; carve strokes are chunk patches already).

## 6. Sync + events (no new server logic)

- `update-terrain` gains `water: { bodies: [...] }` (full list per change —
  it's tiny). Server stores it opaquely like today, relays to the room.
- Old clients/fields: server keeps clamping only if the old shape arrives;
  new clients ignore `enabled/level` after migration.

## 7. Phasing

- **W1 — Lakes**: pour/fill algorithm, lake meshes, the full shader (depth
  tint, foam, glints, fresnel), level-drag UI, sculpt-reactivity, migration.
  This alone replaces everything v1 did, better.
- **W2 — Rivers**: spline tool, ribbon + carve, flow animation, lake joins.
- **W3 — Waterfalls + polish**: steep-section detection, mist sprites,
  stylization banding pass, sound hooks later.

Open knobs I'll default but you may want opinions on: shallow/deep colors
(teal→deep blue), foam width (~0.35 u), default lake `maxRadius` (96 u),
banded vs smooth stylization (I'll ship the uniform and we pick live).
