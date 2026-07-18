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

Then open http://localhost:3000. Log in with any username — the name `gm`
(case-insensitive) gets GM powers.

## Routes

| Route       | What it is |
|-------------|------------|
| `/`         | Character creator (SRD 5.1 rules, live 3D preview of the tabletop model) |
| `/gm`       | GM screen: world map ladder (Continent → Kingdom → Province → Tactical), terrain editing, object placement, structures, combat tracker |
| `/player`   | Player screen: shared map view + character-sheet HUD |
| `/homebrew` | Custom race/class builder |

## Features

- **One infinite procedural world** — elevation/moisture fields drive biomes,
  streamed in chunks with LOD rings, animated ocean, floating origin. The hex
  map tiers (Continent 60mi / Kingdom 6mi / Province 1mi, per the DMG ladder)
  are zoom lenses over the same ground, not separate maps.
- **GM world editing** — heightmap brushes, biome painting (which reshapes the
  actual generator, not just colors), poured lakes and spline rivers,
  tile-brush structures (walls/floors, with a seeded "scruffy" ruins variant).
- **Pocket maps** — portal-linked dungeon/interior maps separate from the
  overworld.
- **Server-authoritative 5e combat** — initiative tracker, turn/range
  overlays, attack/dash/dodge/disengage actions and conditions; the server
  rolls all dice and enforces turns and movement.
- **Character creator & homebrew** — SRD 5.1 rules math (AC, HP, spell slots,
  weapon attacks), plus custom races/classes shared to every screen.

## Data & persistence

Runtime state (characters, maps, homebrew) is saved as JSON under
`data/saves/` (gitignored). Login is unauthenticated and owner checks are
advisory — this is a trusted-table tool, not a hardened service.

## Licensing

Game rules content comes from the System Reference Document 5.1 (SRD 5.1);
see [data/srd/ATTRIBUTION.md](data/srd/ATTRIBUTION.md) for attribution and
license details.
