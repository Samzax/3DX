# Unified Infinite World — Design

> **Status (2026-07):** U1–U4 implemented and live. U4 shipped as the
> fog-of-war half of the merged decision below: a GM-painted reveal mask on a
> global province-pitch hex lattice (`update-fog`/`fog-updated`,
> `shared/fog.js`), with the server withholding objects and terrain edits
> outside revealed hexes per player. Full windowed chunk *subscription*
> (streaming sync for scale, `subscribe-region`) remains reserved for when
> world size demands it — fog filtering already implements its gating half.

## The pivot

Today each tactical leaf (`world/a/b/c`) is its own island with its own socket
room and terrain blob; hexes are *navigation into separate maps*. The new model:
**one continuous world**. A hex is an *address into that world*, not a door to a
different one. Double-clicking a hex flies the camera there and steps zoom in;
it does not load a new map. Distant terrain, water, and structures simply unload;
near ones stream in. Dungeons/pockets stay genuinely separate spaces (unchanged).

Most of the engine already fits this: chunked terrain is a sparse infinite
lattice with a streaming window — that IS "unrender when far." What changes is
the *keying layer* on top: collapse the per-leaf maps into one world.

## 1. One coordinate space

- World unit = 1 cell = 5 ft (unchanged).
- Province hex ≈ 1 mile ≈ 1056 u across; Kingdom hex = 6×; Continent hex = 60×.
- The world is a single XZ plane spanning ~10^5–10^6 units. Sparse chunks
  (32×32 cells, keyed by integer chunk coords) don't care how large it is —
  only touched chunks and placed objects exist.
- Hex tiers are three axial-hex grids over the *same* ground at three pitches
  (Continent 60mi, Kingdom 6mi, Province 1mi). A hex's world center is pure math;
  no per-hex storage needed for geometry.
- Hexes don't tile into hexes exactly — irrelevant now, because tiers are
  independent overlay lenses over one continuous ground, not nested containers.

## 2. Hex overlays as zoom lenses

- The camera has a continuous zoom. Which hex grid is drawn (or none, at ground
  level) is a function of zoom height — like Google Maps switching country →
  city → street.
- Double-click a hex = fly camera to that world position + drop one zoom tier.
  "Up" = rise one tier, recentering on the parent hex. Breadcrumb shows the
  hex address of whatever is under the camera, derived from position (not stored).
- No `join-map` for tiers anymore; it remains only for entering pockets/dungeons.

## 3. World LOD — every tier is a *resume* of the tier below

The rule "an n+1 hex summarizes its n hexes" becomes the rendering strategy AND
what makes an infinite world affordable:

- **Near (Province zoom and closer):** stream real chunks — full terrain, water,
  structures — within the window. This is the only tier that loads geometry.
- **Far (Kingdom / Continent zoom):** do NOT stream chunks. Render each hex as a
  single **summary tile**: dominant-biome color, an elevation-shaded tint, and
  small icons for {has water, has settlement, has dungeon}. Thousands of these
  are cheap (flat colored hexes). The summary *is* the far LOD — distant world
  isn't blank, it's its own resume.
- **The summary is a faithful downsample, not just the coarse paint.** Each hex
  keeps a cached summary record aggregated from everything beneath it:
  `{ dominantBiome, meanElevBand, waterFraction, structureCount }`. When the GM
  edits a fine chunk or drops a building, the summary of its Province hex is
  marked dirty; dirty flags propagate up (Province → Kingdom → Continent),
  recomputed lazily on next view. So zooming out always shows what's really
  there — a live minimap of the world.
- Zooming in = summaries resolve into real geometry as chunks stream; zooming
  out = geometry unloads back into summary tiles. One smooth continuum.

## 4. Implicit ground: the biome field generates, edits override

- The biome painting becomes a **multi-resolution world field**: coarse cells at
  Continent scale, finer at Kingdom, finest at Province (painting a finer tier
  overrides the coarser one there — exactly the current "deepest tag wins", but
  now it's the world's base layer, not a per-map tag).
- **Unedited ground is generated on demand** from the biome field + deterministic
  noise (the `seedFromBiome` generator already written, applied per-chunk keyed
  by world position instead of as a one-time 4×4 block). The entire infinite
  world is implicitly the biome painting until a GM edit overrides specific
  chunks. Storage stays tiny: only edited chunks + objects + the biome field
  persist.
- This kills the current awkward "seed a 4×4 patch on first entry" — the world
  is *already* full everywhere, consistently, for free.

## 5. Floating origin (the one genuinely hard bit)

- GPUs use 32-bit floats; at ~500k-unit coordinates, vertices jitter visibly.
- Fix (standard in every open-world engine): geometry is built **chunk-local**,
  and a world offset keeps the camera region near (0,0,0). As the camera travels
  past a threshold, rebase: shift the offset, translate active meshes. Raycasts,
  snapping, ruler, and object placement all go through a `worldToLocal` /
  `localToWorld` pair so game logic stays in true world coords.
- This touches the render path, picking, and snapping — the reason this pivot is
  a real project, not an evening.

## 6. Windowed subscription (sync that scales to one world)

- One world can't broadcast everything forever. Clients **subscribe to the
  region around their view**: `subscribe-region { center, radius }` →
  `chunks-data` / `objects-data` for that window; leaving the window drops them.
  (The chunk design reserved this for fog of war; here it becomes the core sync.)
- The server indexes chunks and objects by chunk coord; a region query is a
  bounded lookup. Far tiers pull **summary records** instead of chunks.
- This is also 80% of fog of war: withholding chunks a player shouldn't see is
  the same mechanism as not-yet-subscribed chunks.

## 7. Structures & tokens

- Objects carry true world positions, bucketed by chunk. Within the window they
  render; outside, they unload — the same window as terrain. A building far away
  contributes only to its hex's summary (structureCount/icon), not geometry.

## 8. Migration

- Each existing tactical island has a computable world position (compose its hex
  offsets down the ladder × tier widths). On load, stamp its chunks into the
  world at that position; its old room key is dropped.
- Existing biome tags become the coarse biome field cells at their tier.
- Pockets are untouched (already separate).

## 9. Phasing

- **U1 — Unified space + navigation.** One world, floating origin, zoom-lens
  camera + hex overlays, migrate existing islands to world positions. (Far tiers
  can render as plain biome-color hexes at first — crude summary.)
- **U2 — Implicit generated ground.** Per-chunk biome generation with edit
  overrides; retire the one-shot seed block.
- **U3 — World LOD resumes.** Summary records + aggregation pyramid + dirty
  propagation + icon rendering — the true "n+1 = resume of n."
- **U4 — Windowed subscription.** Region subscribe/unsubscribe for chunks &
  objects; summary fetch for far tiers. (Doubles as fog-of-war groundwork.)

## Open defaults (say if you disagree)

- Zoom→tier thresholds (camera height at which grid switches) — I'll tune by eye.
- Summary icon set (water / settlement / dungeon) — start with these three.
- Rebase threshold distance for the floating origin (e.g. every 4096 u).
- ~~Whether players can free-roam the world map or only follow the GM's view~~
  **DECIDED: players free-roam independently, but only receive regions the GM
  has revealed.** U4 subscription is therefore per-player region streaming
  filtered through a GM-controlled visibility (fog) mask — free camera, gated
  content. This merges the subscription and fog-of-war work.
