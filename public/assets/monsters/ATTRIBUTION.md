# Monster GLB attribution

`glbs/` holds freely-licensed 3D models used by `kind: 'gltf'` manifest
entries (mapped in `tools/gltf-model-map.json`). All models are by
**Quaternius** (quaternius.com), downloaded via **poly.pizza**
(https://poly.pizza/u/Quaternius).

License: **CC0 1.0 Universal (Public Domain Dedication)** — no attribution
is legally required; this file is given as courtesy and provenance.

Packs used:

| Pack | Files (prefix) |
|------|----------------|
| Ultimate Monsters | `um-*.glb` |
| Animated Enemies | `ae-*.glb` |
| Animated Animals | `aa-*.glb` |
| Dinosaurs | `di-*.glb` |
| Fish / Sea Creatures | `fi-*.glb` |
| Farm Animals | `fa-*.glb` |
| Enemies | `en-*.glb` |
| Animated Zombie | `zo-*.glb` |

Notes:

- The CC-BY "Animated Zombie" variant was deliberately **not** vendored; only
  the CC0 zombie file is here.
- Files not referenced by `gltf-model-map.json` are a spare pool and are not
  rendered yet.
- Keep this file updated when adding models; verify the license on the source
  page before vendoring (CC0 only, never CC-BY-NC / no-redistribution).
