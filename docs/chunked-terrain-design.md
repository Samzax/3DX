# Chunked Terrain — Design

> **Status (2026-07):** implemented; superseded in part by
> `unified-world-design.md` (the per-leaf islands it describes were folded
> into the one `@world` store). Kept for the chunk/payload format reference.

Goal: replace the fixed 100×100-cell terrain island with a **virtually infinite, sparsely
stored, streamed** tactical map. This is the foundation for: the infinite open world,
per-chunk fog of war, biome-seeded terrain, and chunk-aware water v2.

## 1. Coordinate model

- **Cell** = 1 world unit = 5 ft (unchanged, `GRID_CELL_SIZE`).
- **Vertex lattice**: heightmap vertices every **0.5 units** (2 per cell edge). Global
  integer vertex coords `(gx, gz)`; world position = `(gx * 0.5, gz * 0.5)`.
  (Today's terrain is 128 verts over 100 units ≈ 0.78 spacing, *not* aligned to cells;
  the new lattice is denser and grid-aligned, which also improves brush precision.)
- **Chunk** = 32×32 cells = 32 units square = **64×64 unique vertices**.
  Chunk coords `(cx, cz)` are signed integers, unbounded. Key string: `"cx,cz"`.
  A vertex `(gx, gz)` belongs to chunk `(floor(gx/64), floor(gz/64))`.

**Vertex ownership (seam correctness):** each chunk stores only its 64×64 unique
vertices. A chunk's *mesh* is 65×65 vertices — its own 64 rows/cols plus one apron
row/col sampled from the neighboring chunks' data. Positions therefore agree at seams
by construction (single source of truth per vertex, no duplicated storage to drift).
Normals are computed from a 66×66 sample window so lighting is also seamless.

## 2. Storage & payloads

Per-chunk data:

| layer   | array                   | raw     | base64  |
|---------|-------------------------|---------|---------|
| heights | Int16 ×  64×64 (quantized 0.05) | 8 KB   | ~11 KB |
| splat   | Uint8 × 64×64×4 (RGBA weights) | 16 KB  | ~22 KB |

Server-side map record (format v2):

```json
"terrain": {
  "format": 2,
  "chunkCells": 32,
  "vertexSpacing": 0.5,
  "water": { "enabled": false, "level": 0 },
  "chunks": {
    "0,0":  { "heights": "<b64>", "splat": "<b64>" },
    "-1,3": { "heights": "<b64>" }
  }
}
```

- **Sparse**: only chunks the GM has touched exist. Untouched space is implicit flat
  default ground (rendered by the existing tabletop plane under the chunks).
- A chunk may omit `splat` (all-grass) or `heights` (flat) — only edited layers stored.
- `water` stays a global level per map for now; **water v2 will replace this field**
  (designed chunk-aware; nothing else in this format assumes global water).
- Reserved for fog of war later: `"visible": { "cx,cz": true }` — per-chunk mask,
  same keys, no format change needed.
- Persistence stays in `map_state.json` for now. Growth path (not in this phase):
  one file per map under `data/saves/maps/`. The server treats blobs opaquely either way.

## 3. Sync protocol (server stays a dumb relay)

- `update-terrain` (GM → server → room), extended:
  `{ chunks: { "cx,cz": { heights?, splat? } }, water? }`
  Server merges per chunk per layer, saves, relays as `terrain-updated` (same shape).
  A brush stroke marks dirty chunks during the drag and sends them **once on
  stroke-end** (a radius-12 brush touches ≤ 4 chunks; payload ≈ 130 KB worst case,
  under the 512 KB socket buffer; typical strokes touch 1–2 chunks).
- `map-state` includes the full sparse `terrain` object (all stored chunks).
  Fine up to a few hundred edited chunks (~10 MB at 300 chunks). **Phase B**
  (with fog of war) adds windowed subscription — `subscribe-chunks { keys[] }` /
  `chunks-data { chunks }` — so players only ever receive chunks the GM has revealed
  and clients of huge maps load lazily. Event names reserved now, implemented later.
- Old-format maps (`res: 128`): the GM client detects format v1 on load, resamples
  bilinearly onto the new lattice (covering the same 100×100 area → chunks (-2..1)²
  region), and emits it back as v2. One-time, automatic, players just receive v2.

## 4. Client architecture (`terrain.js` refactor)

`Terrain` (one big mesh) becomes `TerrainChunks`:

- `chunks: Map<"cx,cz", { heights: Float32Array, splat: Uint8Array, mesh: THREE.Mesh|null, dirty: bool }>`
- **One shared material** for all chunk meshes (same Lambert + brush-cursor shader
  from the editor UX pass — uniforms shared, so the brush ring spans chunk borders
  correctly for free).
- Global accessors used by everything else (no other file knows about chunks):
  - `sampleHeight(x, z)` — bilinear over the lattice, 0 where no chunk exists.
  - `sculpt/paint/ramp(...)` — same signatures as today; internally resolve affected
    vertices → owning chunks, auto-create missing chunks, mark dirty (+ neighbors
    whose apron changed), rebuild dirty meshes on stroke throttle.
  - `snapshot()/restore()` for undo — snapshots only the chunks touched since the
    stroke started (cheap), not the world.
- **Streaming window**: each frame (throttled), compute the chunk window around
  `controls.target` (radius ~3 chunks ≈ 100 units). Chunks entering the window get
  meshes built; chunks leaving get meshes disposed (data stays in memory; it's small).
  Hysteresis of 1 chunk to avoid thrash at boundaries.
  - GM budget check: 7×7 window = 49 meshes × ~8k tris ≈ 400k tris — trivial.
- **Water (interim)**: same submerged-cell surface as today, built per chunk over its
  own cells at the global level. Behavior unchanged; replaced wholesale by water v2.
- Objects/tokens: `groundY` already goes through `sampleHeight` — works anywhere.

## 5. What deliberately does NOT change

- Socket rooms, map keys, objects, rulers, characters — untouched.
- The hex layers (world/region) — untouched by this phase; DMG scale ladder
  (Continent 60 mi / Kingdom 6 mi / Province 1 mi) is a separate, small change.
- Editor tools/UX — all brushes, undo, hotkeys work identically through the new
  global accessors.
- Grid rendering — the existing 1000-unit GridHelper is kept for now (follow-camera
  grid is a later cosmetic).

## 6. Phasing

- **A1 — chunk core**: `TerrainChunks`, format v2 + migration, per-chunk sync,
  fixed window streaming. Everything above except windowed subscription.
- **A2 — polish**: window hysteresis tuning, per-map save files if needed,
  follow-camera grid if it bothers.
- **B — windowed subscription** (lands with fog of war): players receive only
  revealed chunks; `subscribe-chunks` protocol; GM fog painting per chunk.

Risks & mitigations: seam bugs (unique ownership + apron makes them structural,
not incidental; test = sculpt a hill exactly on a 4-chunk corner), payload spikes
(dirty-set capped per stroke by brush radius), old saves (auto-migration tested
against the current playtest map before merging).
