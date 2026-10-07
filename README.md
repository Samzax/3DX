# 3DX

A D&D 5e virtual tabletop with a procedural, infinite 3D world.

Node/Express + Socket.IO server with vanilla-JS ES-module clients
(three.js vendored locally, no build step). All state is shared live over
sockets: the GM shapes the world, players roam it, and the server referees
combat.

## Quick start

```
npm install
npm start
```

Then open http://localhost:3000/lobby — the campaign browser is the entry
point for every screen (the character creator is still served at `/`). Log in with any username — the name `gm`
(case-insensitive) gets GM powers.

Run the dependency-free regression suite with `npm test`.

## Routes

| Route       | What it is |
|-------------|------------|
| `/lobby`    | Campaign browser: pick or create a campaign, then enter as GM or with selected characters |
| `/`         | Character creator (SRD 5.1 rules, live 3D preview of the tabletop model); `?campaign=<id>` scopes the roster |
| `/gm`       | GM screen: world map ladder (Continent → Kingdom → Province → Tactical), terrain editing, object placement, structures, combat tracker |
| `/player`   | Player screen: shared map view + character-sheet HUD |
| `/homebrew` | Custom monster/race/class builder |

`/gm` and `/player` require `?campaign=<id>`; lobby and workspace links always
carry it.

## Features

- **Campaigns** — a lobby browser with a 5-step worldbuilding wizard (name,
  style + seed, biome palette, spawn point, party). Each campaign owns its
  maps, roster, settings and presence with no cross-talk; region-style
  campaigns lock navigation to a single province, and characters can be
  exported/imported as JSON files.
- **World settings per campaign** — presets (Continents, Archipelago,
  Heartland, Highlands, Frozen North, Sunscorched, Classic) over fine-tune
  knobs for ocean share, landmass size, ruggedness, rainfall, temperature,
  climate bands and region size, with a live preview map you click to place
  the spawn and an optional guaranteed homeland around it. Snow follows
  temperature and altitude, cold seas freeze, and the GM can change the
  season for the whole table without regenerating anything.
- **One infinite procedural world** — elevation/moisture fields drive biomes,
  streamed in chunks with LOD rings, animated ocean, floating origin. The hex
  map tiers (Continent 60mi / Kingdom 6mi / Province 1mi, per the DMG ladder)
  are zoom lenses over the same ground, not separate maps.
- **GM world editing** — heightmap brushes, biome painting (which reshapes the
  actual generator, not just colors), poured lakes and spline rivers,
  multi-storey tile-brush structures (terrain-following or elevated/basement
  floors, straight or L-shaped wall runs with layered procedural panels,
  stairs, level cutaways,
  per-cell doors/windows/gaps,
  cut/restore floor and roof cells, flat/gable/hip roofs with ceiling
  undersides, explicit building grouping, whole-storey duplication above or
  below, and a seeded "scruffy"
  ruins variant).
- **Pocket maps** — portal-linked dungeon/interior maps separate from the
  overworld.
- **Server-authoritative 5e combat** — initiative tracker, turn/range
  overlays, attack/dash/dodge/disengage actions and conditions; the server
  rolls all dice and enforces turns and movement.
- **Character creator & homebrew** — SRD 5.1 rules math (AC, HP, spell slots,
  weapon attacks), plus custom monsters/races/classes shared to every screen.
- **Monster library** — 334 CC-BY SRD 5.1 creatures plus table-made monsters,
  searchable by name/type/CR and placeable as size-aware combat tokens. Their
  AC, HP, speed, initiative, saves, and standard attacks seed encounters.

## Data & persistence

Runtime state (characters, maps, homebrew) is saved as JSON under
`data/saves/` (gitignored), or under `THREEDX_DATA_DIR` when that environment
variable is set. The default campaign stores its files directly in the saves
dir; every other campaign gets its own `campaigns/<id>/` subdirectory.
Writes use a flushed temporary file plus atomic rename and
keep a parseable `.bak` recovery copy. GM/player mutation permissions and
payload bounds are enforced server-side, but login still trusts the supplied
username — this remains a trusted-table tool, not an internet-facing auth
service.

## Licensing

Game rules content comes from the System Reference Document 5.1 (SRD 5.1);
see [data/srd/ATTRIBUTION.md](data/srd/ATTRIBUTION.md) for attribution and
license details.
