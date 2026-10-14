# Handoff: generating a race body with the Meshy API

Written 2026-10-08. Use this to add one race body form per session (tabaxi variants, lizardfolk, tiefling, orc…).
Paste the "Prompt for a new session" block at the bottom, filling in the race.

## State

- **Meshy API works on the Pro plan, no extra tier.** It spends the same credit pool as the web app (983 on 2026-10-08). One body is about 30 credits (mesh 20 + texture 10; `--ultra` adds 5).
- **The key is the Windows user variable `MESHY_API_KEY`.** It is not in any repo or file. Programs opened before it was set do not see it; `meshy_gen.py` falls back to reading the user variable from the registry.
- **New script:** `E:\3DGen\projects\3dx-dragonborn\scripts\meshy_gen.py` (Multi-Image to 3D, polls, downloads the GLB). It replaces driving the web UI through Chrome and `grab.sh`.
- **Not yet proven:** the balance check and `--dry` run pass, but no paid generation has gone through the script. Treat the first real run as the test (response field names for thumbnails are the likeliest thing to need a fix; the GLB download is standard).
- **Meshy's developer console renders blank in the Chrome extension tab.** Don't go there for keys or usage; use `meshy_gen.py --balance`.

## The pipeline for one race

Everything runs from `E:\3DGen\projects\3dx-dragonborn`. ComfyUI (`C:\COMFYY`) must be up for steps 1–2. Run GPU jobs one at a time (a Blender bake and a ComfyUI job together starve each other on the 3090).

| # | Step | Command | Output | Gate |
|---|------|---------|--------|------|
| 1 | Concepts | copy `scripts/gen_tabaxi.py`, rewrite `BODY` + `CONCEPTS` for the race, run with `<seed>,<seed>` | `references/<race>/<key>-s<seed>.png` | **Owner picks** the concept(s) |
| 2 | Turn-around views | `python scripts/gen_sets.py views <seed> <key>=<concept file>` | `references/sets/views/<key>-front/side/back.png` | Check **every** view for tail, horns, wings, ears before spending credits |
| 3 | Sculpt | `python scripts/meshy_gen.py <race>-<key> <front> <side> <back>` | `meshy/<race>-<key>.glb`, `renders/meshy-<race>-<key>-*.png`, `meshy/<race>-<key>.json` | Look at the thumbnails; **owner approves** before step 4 |
| 4 | Body form | `bash scripts/run_form.sh body-<key> <race>-<key> meshy/<race>-<key>.glb [human]` | `pack/3dx_parts/clothes/<race>_<key>/`, `pack/3dx_parts/targets/<race>-<key>.target`, `renders/align-body-<key>-*.png` | Check the align overlays: the kit body must sit inside the sculpt |
| 5 | Catalog | add one `A('bodyform', '<race>-<key>', '3dx_parts/clothes/<race>_<key>', '<Label>', {...})` line to `tools/character-kit-assets.mjs` | — | — |
| 6 | Kit | `node tools/build-character-kit.mjs --assets E:/3DGen/cache/makehuman-packs/x --parts E:/3DGen/projects/3dx-dragonborn/pack` (from `C:\code\3DX`) | `public/assets/characters/mh/assets/<race>-<key>/` | — |
| 7 | Race hookup | default body form for the race: `public/js/shared/charmesh.js` (~line 388) and `public/js/pages/creator.js` (~line 579) | — | — |
| 8 | Verify | `/creator`: pick the race, Appearance tab; walk the sliders, dress it, equip plate/mail/leather; then a token on `/gm` + `/player` | — | **Owner signs off** |

Notes per step:

- **Step 1.** Keep the wording that worked: upright on two straight human-like legs, heels on the ground, human-proportioned torso and arms, neutral symmetric A-pose with arms 45° from the body, a plain loincloth only, grey studio background, "semi-realistic fantasy game character render". The body form is bound to a human kit body, so digitigrade legs, extra limbs and big wings will not bind well.
- **Step 2.** For a tailed race whose side view loses the tail, `scripts/gen_side_tail.py <key> <seed>` retries the side view (its prompt is leopard-specific; edit it). Meshy trusts a view that has no tail and drops it.
- **Step 3.** Front view first; order of the rest does not matter. Defaults: latest model, 4K texture, PBR maps, no remesh (`prep_low.py` makes the game mesh). `--task <id>` resumes a submitted task without paying again; the id is in `meshy/<name>.json`. The script refuses to overwrite an existing GLB.
- **Step 4.** `human` tells `align.py` the figure is human-sized (the tabaxi); leave it off for a bulkier-than-human race (the dragonborn). `run_form.sh` did not pass this flag before today, so how the existing tabaxi were aligned is unconfirmed; compare both overlays if the fit looks off. `work/body-<key>-*` holds the intermediate files.
- **Step 5.** Copy an existing line. Per-form knobs: `armSpread` (arm carriage, 0.05 lean … 0.3 brute), `clothGap` (0.05 for fur, default 0.22 for scales), `neckHold` (0.85 when the head hangs low and forward). `license: 'private'`, `covers: FORM_COVERS`, `replacesFace: true`, `target: '<race>-<key>'`.
- **Step 7.** Types of one race blend with each other because their ids share the prefix before the first `-` (`creator.js` `kin`).

## Rules that still apply

- The sculpts are the owner's private Meshy output: **never commit** `public/assets/characters/mh/assets/<race>-*` without asking. This doc and the 3DGen scripts hold no key.
- Never present a visibly mismatched result as a milestone. If the sculpt is wrong (missing tail, fused fingers, heel blocks), regenerate instead of patching around it.
- Ask before each paid generation beyond the one the owner approved; report the balance before and after.
- Known rough spots on existing forms: leopard heel blocks, a small armpit fin on the cheetah, type B shoulder plates stretching, no helms for body forms.
- Unused concepts already on disk: `references/tabaxi/snow-leopard-s6x.png`, `black-panther-s6x.png` (the owner has not asked for them).

## Prompt for a new session

```
Read docs/race-generation-handoff.md and add a body form for: <RACE> (<one line on the look I want>).
Follow the 8 steps. Stop and show me the concepts (step 1) and the Meshy thumbnails (step 3) before going on.
Budget: <N> Meshy generations.
```
