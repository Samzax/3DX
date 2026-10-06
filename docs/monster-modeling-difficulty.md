# SRD monster 3D-model production matrix

This document estimates the relative difficulty of producing an original, accurate-to-text, game-ready 3D asset for every monster record in `data/srd/monsters.json`. It is an internal art-production aid only; these tiers are not game data.

## Scope and method

The estimate assumes a stylized-realistic asset with concept pass, sculpt/model, retopology, UVs, PBR materials, a usable rig, and basic locomotion/attack hookup. It does **not** include a full animation library, spell-effect package, audio, cinematics, or every alternate form named in the rules. Technical effects that materially determine the creature's appearance—incorporeality, swarming, translucency, elemental bodies, deformation, or transformation—still raise the tier or appear under Technical risks.

- **T1 — Reuse / kitbash:** primarily an existing humanoid, animal, or prop base; small proportion, equipment, grooming, or texture changes.
- **T2 — Light bespoke:** a recognizable base anatomy with a meaningful custom sculpt, appendage, costume, or modest rig extension.
- **T3 — Bespoke creature:** a distinct silhouette or material treatment needing a dedicated sculpt, specialist rigging, or a technical presentation system.
- **T4 — Complex asset:** unusual or hybrid anatomy, several interacting technical systems, or a large signature creature needing substantial iteration.
- **T5 — Hero / technical boss:** a flagship asset with dedicated concept development, high-complexity topology and rigging, multiple signature systems, and boss-level polish.

Reuse is recorded independently from difficulty: **R3** is a direct variant of an existing production master, **R2** is a shared-rig family derivative, **R1** reuses components or systems only, and **R0** is effectively standalone. Every R2/R3 row names its intended anchor in the production note. Anchors are production targets, not proof that an asset already exists; when a named master is still unbuilt, schedule and cost that first build before claiming the derivative saving.

Technical-risk flags are deliberately controlled vocabulary: `WING`, `MULTIHEAD`, `MULTILIMB`, `MULTI-FEATURE`, `TENTACLE`, `SERPENT`, `DEFORM`, `TRANSFORM`, `CLOTH`, `CHAIN`, `EXTREME-SCALE`, `SPECTRAL`, `ELEMENTAL`, `TRANSLUCENT`, `EMISSIVE`, `INVISIBLE`, `SWARM`, `FOLIAGE`, `UNDERWATER`, `CONCEPT-SPARSE`, `FORM-SCOPE`, and `ORIGINAL-DESIGN`. `NONE` means no unusual modeling-system risk beyond ordinary character production.

Tiers describe the **standalone first-build difficulty** of each record. Production order changes the actual cost: once a family master, skeleton, shaders, and animation set exist, later sizes, colors, roles, or forms can be much cheaper. The Base family and Reuse potential columns call out those savings; do not add every row as an independent sculpt estimate.

The SRD supplies rules text, not an open visual bible. “Accurate” here means an original interpretation consistent with SRD 5.1 descriptions and game mechanics. Do not copy Monster Manual, D&D Beyond, miniature, or other proprietary artwork, and do not use the JSON `image` URLs as modeling references. SRD-derived text must retain the project's SRD 5.1 / CC BY 4.0 attribution; newly created models and concept art need their own documented provenance.

Current distribution: **T1 100**, **T2 89**, **T3 86**, **T4 41**, **T5 18** (334 total). Reuse distribution is **R0 41**, **R1 72**, **R2 152**, and **R3 69**. T3 includes deliberate promotions for effects-dependent creatures such as swarms, oozes, spectral bodies, elemental volumes, and linked transformations.

## Complete matrix

| Monster | Tier | Base family | Reuse potential | Technical risks | Production note |
|---|---|---|---|---|---|
| Aboleth | T5 | Aquatic tentacled body | R0 | MULTILIMB, TENTACLE, UNDERWATER, CONCEPT-SPARSE, ORIGINAL-DESIGN | SYSTEM=underwater tentacle locomotion and mucus surface; design an original silhouette around tentacle, tail, and swim mechanics without copying proprietary depictions. |
| Acolyte | T1 | Biped humanoid | R3 | CLOTH | ANCHOR=Modular humanoid core; DELTA=junior cleric robes, focus, and club; preserve role readability at token distance. |
| Adult Black Dragon | T4 | Winged draconic quadruped | R2 | WING, UNDERWATER | ANCHOR=True-dragon master; VARIANT_OF=Black dragon age set; DELTA=adult proportions, black palette/material treatment and breath-effect cues. |
| Adult Blue Dragon | T4 | Winged draconic quadruped | R2 | WING | ANCHOR=True-dragon master; VARIANT_OF=Blue dragon age set; DELTA=adult proportions, blue palette/material treatment and breath-effect cues. |
| Adult Brass Dragon | T4 | Winged draconic quadruped | R2 | WING | ANCHOR=True-dragon master; VARIANT_OF=Brass dragon age set; DELTA=adult proportions, brass palette/material treatment and breath-effect cues. |
| Adult Bronze Dragon | T4 | Winged draconic quadruped | R2 | WING, UNDERWATER | ANCHOR=True-dragon master; VARIANT_OF=Bronze dragon age set; DELTA=adult proportions, bronze palette/material treatment and breath-effect cues. |
| Adult Copper Dragon | T4 | Winged draconic quadruped | R2 | WING | ANCHOR=True-dragon master; VARIANT_OF=Copper dragon age set; DELTA=adult proportions, copper palette/material treatment and breath-effect cues. |
| Adult Gold Dragon | T4 | Winged draconic quadruped | R2 | WING, UNDERWATER | ANCHOR=True-dragon master; VARIANT_OF=Gold dragon age set; DELTA=adult proportions, gold palette/material treatment and breath-effect cues. |
| Adult Green Dragon | T4 | Winged draconic quadruped | R2 | WING, UNDERWATER | ANCHOR=True-dragon master; VARIANT_OF=Green dragon age set; DELTA=adult proportions, green palette/material treatment and breath-effect cues. |
| Adult Red Dragon | T4 | Winged draconic quadruped | R2 | WING | ANCHOR=True-dragon master; VARIANT_OF=Red dragon age set; DELTA=adult proportions, red palette/material treatment and breath-effect cues. |
| Adult Silver Dragon | T4 | Winged draconic quadruped | R2 | WING | ANCHOR=True-dragon master; VARIANT_OF=Silver dragon age set; DELTA=adult proportions, silver palette/material treatment and breath-effect cues. |
| Adult White Dragon | T4 | Winged draconic quadruped | R2 | WING, UNDERWATER | ANCHOR=True-dragon master; VARIANT_OF=White dragon age set; DELTA=adult proportions, white palette/material treatment and breath-effect cues. |
| Air Elemental | T3 | Amorphous aerial volume | R2 | ELEMENTAL, DEFORM, TRANSLUCENT | ANCHOR=Elemental shader framework; SYSTEM=animated translucent wind volume; silhouette must remain targetable on bright maps. |
| Ancient Black Dragon | T5 | Winged draconic quadruped | R2 | WING, EXTREME-SCALE, UNDERWATER | ANCHOR=True-dragon master; VARIANT_OF=Black dragon age set; DELTA=ancient proportions, black palette/material treatment and breath-effect cues. |
| Ancient Blue Dragon | T5 | Winged draconic quadruped | R2 | WING, EXTREME-SCALE | ANCHOR=True-dragon master; VARIANT_OF=Blue dragon age set; DELTA=ancient proportions, blue palette/material treatment and breath-effect cues. |
| Ancient Brass Dragon | T5 | Winged draconic quadruped | R2 | WING, EXTREME-SCALE, TRANSFORM, FORM-SCOPE | ANCHOR=True-dragon master; VARIANT_OF=Brass dragon age set; DELTA=ancient proportions, brass palette/material treatment and breath-effect cues; SCOPE=Change Shape forms are separate linked assets. |
| Ancient Bronze Dragon | T5 | Winged draconic quadruped | R2 | WING, EXTREME-SCALE, UNDERWATER, TRANSFORM, FORM-SCOPE | ANCHOR=True-dragon master; VARIANT_OF=Bronze dragon age set; DELTA=ancient proportions, bronze palette/material treatment and breath-effect cues; SCOPE=Change Shape forms are separate linked assets. |
| Ancient Copper Dragon | T5 | Winged draconic quadruped | R2 | WING, EXTREME-SCALE, TRANSFORM, FORM-SCOPE | ANCHOR=True-dragon master; VARIANT_OF=Copper dragon age set; DELTA=ancient proportions, copper palette/material treatment and breath-effect cues; SCOPE=Change Shape forms are separate linked assets. |
| Ancient Gold Dragon | T5 | Winged draconic quadruped | R2 | WING, EXTREME-SCALE, UNDERWATER, TRANSFORM, FORM-SCOPE | ANCHOR=True-dragon master; VARIANT_OF=Gold dragon age set; DELTA=ancient proportions, gold palette/material treatment and breath-effect cues; SCOPE=Change Shape forms are separate linked assets. |
| Ancient Green Dragon | T5 | Winged draconic quadruped | R2 | WING, EXTREME-SCALE, UNDERWATER | ANCHOR=True-dragon master; VARIANT_OF=Green dragon age set; DELTA=ancient proportions, green palette/material treatment and breath-effect cues. |
| Ancient Red Dragon | T5 | Winged draconic quadruped | R2 | WING, EXTREME-SCALE | ANCHOR=True-dragon master; VARIANT_OF=Red dragon age set; DELTA=ancient proportions, red palette/material treatment and breath-effect cues. |
| Ancient Silver Dragon | T5 | Winged draconic quadruped | R2 | WING, EXTREME-SCALE, TRANSFORM, FORM-SCOPE | ANCHOR=True-dragon master; VARIANT_OF=Silver dragon age set; DELTA=ancient proportions, silver palette/material treatment and breath-effect cues; SCOPE=Change Shape forms are separate linked assets. |
| Ancient White Dragon | T5 | Winged draconic quadruped | R2 | WING, EXTREME-SCALE, UNDERWATER | ANCHOR=True-dragon master; VARIANT_OF=White dragon age set; DELTA=ancient proportions, white palette/material treatment and breath-effect cues. |
| Androsphinx | T4 | Winged lion-human hybrid | R0 | WING | SYSTEM=lion body, feathered wings, and masculine human face; facial expression and mane-wing collisions drive rig tests. |
| Animated Armor | T2 | Armored biped construct | R2 | NONE | ANCHOR=Humanoid armor kit; build a normal suit-of-armor rest silhouette and slam-ready articulation; choose visible interior and plate-gap treatment through original concepting. |
| Ankheg | T3 | Burrowing acid-spray predator | R1 | FORM-SCOPE, CONCEPT-SPARSE, ORIGINAL-DESIGN | Prototype an original body plan supporting burrow, bite/grapple, and forward acid spray; choose limbs, shell, and head anatomy through original concepting. |
| Ape | T1 | Primate biped/quadruped | R2 | NONE | ANCHOR=Primate locomotion rig; DELTA=long-arm weight support, flexible shoulders, fist attacks, and a believable rock-throw windup. |
| Archmage | T1 | Biped humanoid | R3 | CLOTH | ANCHOR=Modular humanoid core; DELTA=senior layered robes and dagger; preserve role readability at token distance. |
| Assassin | T1 | Biped humanoid | R3 | NONE | ANCHOR=Modular humanoid core; DELTA=light armor, concealed blades, and crossbow; preserve role readability at token distance. |
| Awakened Shrub | T2 | Branching shrub puppet | R1 | FOLIAGE | Reuse procedural branch and leaf materials; treat roots as feet and use a short bend chain for rake attacks and wind motion. |
| Awakened Tree | T2 | Tree humanoid | R1 | FOLIAGE | Reuse bark and branch materials; build trunk hips, root feet, and two slam-ready bough arms around a simple biped skeleton. |
| Axe Beak | T2 | Fantasy flightless avian biped | R1 | CONCEPT-SPARSE, ORIGINAL-DESIGN | Reuse flightless-bird leg and neck controls only; derive the oversized axe-like beak, sprint posture, and peck range from its SRD stats as an original design. |
| Azer | T2 | Heat-emitting humanoid | R1 | EMISSIVE, ORIGINAL-DESIGN | Reuse a compact humanoid skeleton; create an original material system for Heated Body, Heated Weapons, and Illumination without importing metal-skin or flame-hair canon. |
| Baboon | T1 | Primate biped/quadruped | R2 | NONE | ANCHOR=Primate locomotion rig; DELTA=narrow torso, long muzzle and tail, ground-running gait, and a fast bite pose. |
| Badger | T1 | Mustelid quadruped | R2 | NONE | ANCHOR=Mustelid rig; DELTA=low barrel body, powerful digging foreclaws, burrow contacts, and coarse striped grooming. |
| Balor | T5 | Flying giant fiend weapon user | R0 | FORM-SCOPE, EMISSIVE, ORIGINAL-DESIGN | SYSTEM=original giant-fiend body supporting flight, fire aura, whip, and sword; decide wings versus magical flight before rig design and reserve weapon clearance. |
| Bandit | T1 | Biped humanoid | R3 | NONE | ANCHOR=Modular humanoid core; DELTA=road-worn leathers, scimitar, and crossbow; preserve role readability at token distance. |
| Bandit Captain | T1 | Biped humanoid | R3 | NONE | ANCHOR=Modular humanoid core; DELTA=command silhouette, coat, scimitar, and dagger; preserve role readability at token distance. |
| Barbed Devil | T2 | Otherworldly humanoid | R1 | NONE | Reuse digitigrade fiend controls; distribute barbs away from bend seams and preserve clear claw and tail attack arcs. |
| Basilisk | T3 | Gaze-and-bite predator | R1 | FORM-SCOPE, CONCEPT-SPARSE, ORIGINAL-DESIGN | Prototype an original body plan supporting a bite, petrifying gaze, and grounded locomotion; choose limb, skin, and head anatomy without borrowing proprietary depictions. |
| Bat | T1 | Winged mammal | R2 | WING | ANCHOR=Bat flight rig; DELTA=finger-supported membrane topology, compact folded rest pose, echolocation-ready head, and bite clearance. |
| Bearded Devil | T2 | Otherworldly humanoid | R1 | NONE | Reuse a lean fiend biped; give the beard tendrils a cheap secondary rig and validate glaive clearance in hunched poses. |
| Behir | T4 | Long-bodied climbing constrictor | R0 | SERPENT, FORM-SCOPE, ORIGINAL-DESIGN | SYSTEM=flexible body supporting climb, constrict, bite, lightning breath, and swallow; decide limb count through original concepting before sculpt lock. |
| Berserker | T1 | Biped humanoid | R3 | NONE | ANCHOR=Modular humanoid core; DELTA=bare-armored raider kit and greataxe; preserve role readability at token distance. |
| Black Bear | T1 | Ursine quadruped | R2 | NONE | ANCHOR=Bear rig; DELTA=leaner shoulders, climbing paw contacts, short dark coat, and bite-to-claw transition. |
| Black Dragon Wyrmling | T3 | Winged draconic quadruped | R2 | WING, UNDERWATER | ANCHOR=True-dragon master; VARIANT_OF=Black dragon age set; DELTA=wyrmling proportions, black palette/material treatment and breath-effect cues. |
| Black Pudding | T3 | Amorphous ooze | R1 | DEFORM, TRANSLUCENT | SYSTEM=viscous climbing body with corrosion and split states; use reusable ooze deformation controls. |
| Blink Dog | T2 | Canid quadruped | R2 | NONE | ANCHOR=Canid rig; DELTA=alert ear and head shapes plus a teleport dissolve that preserves the bite silhouette throughout the effect. |
| Blood Hawk | T1 | Avian biped | R2 | WING | ANCHOR=Raptor flight rig; DELTA=small aggressive proportions, quick banking, strong beak silhouette, and flock-compatible LODs. |
| Blue Dragon Wyrmling | T3 | Winged draconic quadruped | R2 | WING | ANCHOR=True-dragon master; VARIANT_OF=Blue dragon age set; DELTA=wyrmling proportions, blue palette/material treatment and breath-effect cues. |
| Boar | T1 | Porcine quadruped | R2 | NONE | ANCHOR=Porcine rig; DELTA=low neck, tusk and snout shapes, bristled hide, and a straight-line charge pose. |
| Bone Devil | T4 | Flying claw-and-sting fiend | R0 | FORM-SCOPE, ORIGINAL-DESIGN | SYSTEM=original flying fiend anatomy supporting claw, sting, and grapple interactions; choose the flight mechanism before rigging and keep attack appendages deformable. |
| Brass Dragon Wyrmling | T3 | Winged draconic quadruped | R2 | WING | ANCHOR=True-dragon master; VARIANT_OF=Brass dragon age set; DELTA=wyrmling proportions, brass palette/material treatment and breath-effect cues. |
| Bronze Dragon Wyrmling | T3 | Winged draconic quadruped | R2 | WING, UNDERWATER | ANCHOR=True-dragon master; VARIANT_OF=Bronze dragon age set; DELTA=wyrmling proportions, bronze palette/material treatment and breath-effect cues. |
| Brown Bear | T1 | Ursine quadruped | R2 | NONE | ANCHOR=Bear rig; DELTA=heavy shoulder mass, long claws, dense brown coat, and grounded climb and multiattack contacts. |
| Bugbear | T2 | Biped humanoid | R2 | ORIGINAL-DESIGN | ANCHOR=Modular humanoid rig; DELTA=powerful reach-friendly build, morningstar and javelin clearance, and an original face, skin, and hair treatment. |
| Bulette | T3 | Burrowing leap predator | R1 | FORM-SCOPE, CONCEPT-SPARSE, ORIGINAL-DESIGN | Prototype original anatomy for burrowing, standing/deadly leaps, bite, and stable landings before detailing surfaces. |
| Camel | T1 | Camelid quadruped | R1 | NONE | Reuse generic quadruped controls only; build camelid neck, padded feet, long limb proportions, and hump deformation from a dedicated anatomy study. |
| Cat | T1 | Small feline quadruped | R2 | NONE | ANCHOR=General feline master; DELTA=domestic-cat scale, highly flexible spine and tail, precise climb contacts, and fine short-fur grooming. |
| Centaur | T3 | Humanoid-equine hybrid | R1 | NONE | Combine human-torso and equid locomotion modules; solve the waist junction, tight four-leg turns, and weapon reach as one rig. |
| Chain Devil | T3 | Humanoid biped | R1 | CHAIN | Reuse a humanoid biped; author chain attachment points, attack splines, and controlled physics that cannot wrap through the body. |
| Chimera | T4 | Winged multiheaded quadruped | R0 | WING, MULTIHEAD | SYSTEM=lion-goat-dragon head hierarchy on a winged quadruped; validate neck and wing collision volumes. |
| Chuul | T4 | Amphibious pincer-and-tentacle body | R0 | MULTILIMB, TENTACLE, UNDERWATER, ORIGINAL-DESIGN | SYSTEM=original body plan supporting two pincer attacks, grapple, swim/walk movement, and a tentacle follow-up; prioritize attack reach and silhouette. |
| Clay Golem | T2 | Heavy construct biped | R2 | NONE | ANCHOR=Heavy golem skeleton; VARIANT_OF=golem family; DELTA=clay construction, proportions, damage states, and absorption cues. |
| Cloaker | T3 | Flying cloak-like ambusher | R1 | WING, CONCEPT-SPARSE | Build tail, bite/attachment, and a closed dark-leather-cloak false-appearance pose before locking open-flight topology; keep the underside treatment original. |
| Cloud Giant | T2 | Oversized humanoid biped | R2 | NONE | ANCHOR=Giant humanoid skeleton; VARIANT_OF=giant family; DELTA=cloud culture, body proportions, clothing, and signature weapon. |
| Cockatrice | T2 | Winged avian-reptile biped | R1 | WING | Reuse a bird biped and wing skeleton; add a reptilian head and tail while keeping the bite silhouette readable from above. |
| Commoner | T1 | Biped humanoid | R3 | NONE | ANCHOR=Modular humanoid core; DELTA=plain work clothes and club; preserve role readability at token distance. |
| Constrictor Snake | T1 | Serpentine body | R2 | SERPENT, UNDERWATER | ANCHOR=Serpent spline rig; DELTA=broad muscular body, stable coil shapes, constriction contact controls, and swim-to-ground locomotion. |
| Copper Dragon Wyrmling | T3 | Winged draconic quadruped | R2 | WING | ANCHOR=True-dragon master; VARIANT_OF=Copper dragon age set; DELTA=wyrmling proportions, copper palette/material treatment and breath-effect cues. |
| Couatl | T3 | Feather-winged serpent | R1 | WING, SERPENT, TRANSFORM, FORM-SCOPE | Combine a serpent spline with feathered-wing modules; solve long-body flight, wing roots, and supported alternate-form scope early. |
| Crab | T1 | Crustacean body | R2 | UNDERWATER | ANCHOR=Crustacean rig; DELTA=flat shell, sideways gait, articulated claws, and clean walk-to-swim pose changes. |
| Crocodile | T1 | Crocodilian quadruped | R0 | UNDERWATER | ANCHOR=Crocodilian master; SYSTEM=low belly gait, lateral tail propulsion, jaw hinge, and seamless shoreline locomotion transitions. |
| Cult Fanatic | T1 | Biped humanoid | R3 | CLOTH | ANCHOR=Modular humanoid core; DELTA=ritual robes, dagger, and caster props; preserve role readability at token distance. |
| Cultist | T1 | Biped humanoid | R3 | CLOTH | ANCHOR=Modular humanoid core; DELTA=simple ritual garb and scimitar; preserve role readability at token distance. |
| Darkmantle | T3 | Flying cave-formation ambusher | R1 | DEFORM, FORM-SCOPE, CONCEPT-SPARSE, ORIGINAL-DESIGN | Make the ceiling-formation false-appearance pose and face-covering Crush/attachment pose work from one original compact topology; choose the flight anatomy without assuming radial tentacles. |
| Death Dog | T2 | Two-headed canid | R2 | MULTIHEAD | ANCHOR=Canid rig; DELTA=split shoulder and neck topology for two independently aiming heads without collapsing the chest. |
| Deep Gnome (Svirfneblin) | T2 | Biped humanoid | R2 | NONE | ANCHOR=Small humanoid rig; DELTA=stocky subterranean proportions, war-pick and dart grips, and stone-camouflage material variation. |
| Deer | T1 | Cervid quadruped | R2 | NONE | ANCHOR=Cervid rig; DELTA=light barrel, slender hoof contacts, alert neck motion, and a compact bite pose without assuming antlers. |
| Deva | T3 | Winged humanoid | R1 | WING, TRANSFORM, FORM-SCOPE | Reuse winged-humanoid and cloth systems; plan celestial surface cues, mace clearance, and alternate-form scope before topology lock. |
| Dire Wolf | T1 | Canid quadruped | R2 | NONE | ANCHOR=Canid rig; DELTA=heavier chest, broader paws and muzzle, pack-ready bite posture, and mass distinct from an ordinary Wolf. |
| Djinni | T3 | Floating giant humanoid | R1 | ELEMENTAL | Reuse a giant torso and hand rig; pair hovering lower-body motion and loose cloth with scimitar and whirlwind actions. |
| Doppelganger | T3 | Morphing humanoid | R1 | TRANSFORM, FORM-SCOPE | ANCHOR=Humanoid morph rig; SYSTEM=define supported target forms before topology; neutral form still needs original visual design. |
| Draft Horse | T1 | Equine quadruped | R2 | NONE | ANCHOR=Equid rig; DELTA=deep barrel, heavy neck and feathered lower legs, with slow load-bearing gait and planted hoof contacts. |
| Dragon Turtle | T5 | Shelled aquatic dragon | R0 | EXTREME-SCALE, UNDERWATER | SYSTEM=shelled aquatic locomotion and extensible neck; test immense scale both above and below water. |
| Dretch | T2 | Bite-and-claw fiend | R1 | ORIGINAL-DESIGN | Reuse a compact creature skeleton; design original proportions around bite, claw, and Fetid Cloud actions, with a detachable cloud-emitter volume. |
| Drider | T4 | Spider-climbing weapon user | R0 | FORM-SCOPE, ORIGINAL-DESIGN | SYSTEM=original body plan supporting Spider Climb/Web Walker, a bite, and two-handed longsword/longbow use; decide limb count and body junctions through concepting. |
| Drow | T2 | Biped humanoid | R2 | NONE | ANCHOR=Elf humanoid rig; DELTA=light armor, shortsword and hand-crossbow kit, with a distinct silhouette that remains original. |
| Druid | T1 | Biped humanoid | R3 | CLOTH | ANCHOR=Modular humanoid core; DELTA=natural-fiber robes and staff; preserve role readability at token distance. |
| Dryad | T2 | Biped humanoid | R1 | FOLIAGE | Reuse a humanoid skeleton; blend bark across joints, keep foliage off bend seams, and author a tree-stride dissolve mask. |
| Duergar | T2 | Biped humanoid | R2 | NONE | ANCHOR=Dwarf humanoid rig; DELTA=stout armor, war-pick and javelin kit, plus scale-safe equipment for Enlarge. |
| Dust Mephit | T2 | Small winged humanoid | R2 | WING, ELEMENTAL | ANCHOR=Mephit winged-small rig; VARIANT_OF=mephit family; DELTA=dust material, breath cues, and death-burst breakup. |
| Eagle | T1 | Avian biped | R2 | WING | ANCHOR=Raptor flight rig; DELTA=broad soaring wings, foldable primary feathers, hooked beak, and talon strike contacts. |
| Earth Elemental | T3 | Rock humanoid | R2 | ELEMENTAL | ANCHOR=Elemental biped framework; SYSTEM=interlocking rock masses with grounded weight and burrow-safe breakup. |
| Efreeti | T3 | Floating giant humanoid | R1 | ELEMENTAL | Reuse a giant humanoid rig; differentiate fire-forged materials and loose garments while preserving scimitar clearance in flight poses. |
| Elephant | T2 | Proboscidean quadruped | R0 | NONE | ANCHOR=Proboscidean master; SYSTEM=multi-chain trunk, ear secondary motion, tusk clearance, pillar-foot contacts, and weighty turning. |
| Elk | T1 | Cervid quadruped | R2 | NONE | ANCHOR=Cervid rig; DELTA=large chest and neck, antler LODs, sure hoof placement, and separate ram and kick attack lines. |
| Erinyes | T3 | Winged humanoid | R1 | WING | Reuse a winged humanoid skeleton; coordinate feather deformation, fitted armor, longsword draw, and full longbow reach. |
| Ettercap | T3 | Web-climbing bite-and-claw creature | R1 | FORM-SCOPE, ORIGINAL-DESIGN | Build an original body plan around Spider Climb, Web Walker, bite, claw, and web actions; decide humanoid versus arachnid traits during concepting. |
| Ettin | T3 | Two-headed giant biped | R1 | MULTIHEAD | Reuse a giant rig below the shoulders; give each neck independent aim and define arm ownership to prevent head and weapon collisions. |
| Fire Elemental | T3 | Flame humanoid | R2 | ELEMENTAL, EMISSIVE | ANCHOR=Elemental shader framework; SYSTEM=flame body, emissive core, and distortion; provide a low-overdraw fallback. |
| Fire Giant | T2 | Oversized humanoid biped | R2 | NONE | ANCHOR=Giant humanoid skeleton; VARIANT_OF=giant family; DELTA=fire culture, body proportions, clothing, and signature weapon. |
| Flesh Golem | T2 | Heavy construct biped | R2 | NONE | ANCHOR=Heavy golem skeleton; VARIANT_OF=golem family; DELTA=flesh construction, proportions, damage states, and absorption cues. |
| Flying Snake | T1 | Serpentine body | R1 | SERPENT, UNDERWATER, CONCEPT-SPARSE, ORIGINAL-DESIGN | Reuse the serpent spline only; create an original aerial silhouette and flight surface consistent with its fly and swim speeds, then test airborne bite readability. |
| Flying Sword | T2 | Rigid flying prop | R2 | NONE | ANCHOR=Reusable weapon-prop controls; preserve a rigid blade, centered flight pivot, convincing inert rest pose, and broad slash arcs. |
| Frog | T1 | Amphibian quadruped | R2 | UNDERWATER | ANCHOR=Frog anatomy study; DELTA=compact body, webbed feet, swim pose, and elastic jump silhouette; use natural anatomy references. |
| Frost Giant | T2 | Oversized humanoid biped | R2 | NONE | ANCHOR=Giant humanoid skeleton; VARIANT_OF=giant family; DELTA=frost culture, body proportions, clothing, and signature weapon. |
| Gargoyle | T2 | Winged stone humanoid | R1 | WING | Reuse a winged humanoid skeleton; segment stone plates at bend zones and author a compact perched false-appearance pose. |
| Gelatinous Cube | T3 | Amorphous cube | R1 | DEFORM, TRANSLUCENT | SYSTEM=transparent deforming cube with suspended contents; solve refraction, sorting, and engulf states on target hardware. |
| Ghast | T2 | Corpse humanoid | R1 | NONE | Reuse Ghoul corpse topology; lengthen the claws, sharpen the predatory posture, and add a distinct stench-ready material pass. |
| Ghost | T3 | Spectral humanoid | R2 | SPECTRAL, TRANSLUCENT | ANCHOR=Spectral humanoid system; SYSTEM=trailing body, alpha-safe layers, and possession transition; retain facial readability. |
| Ghoul | T2 | Corpse humanoid | R1 | NONE | Reuse a lean humanoid skeleton; sculpt corpse landmarks around deep joint ranges and prioritize bite and paralyzing-claw silhouettes. |
| Giant Ape | T2 | Primate biped/quadruped | R3 | EXTREME-SCALE | ANCHOR=Ape base; VARIANT_OF=Ape; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Badger | T1 | Mustelid quadruped | R3 | NONE | ANCHOR=Badger base; VARIANT_OF=Badger; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Bat | T1 | Winged mammal | R3 | WING | ANCHOR=Bat base; VARIANT_OF=Bat; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Boar | T1 | Porcine quadruped | R3 | NONE | ANCHOR=Boar base; VARIANT_OF=Boar; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Centipede | T2 | Myriapod | R3 | MULTILIMB | ANCHOR=Centipede unit master; DELTA=enlarged segmented shell, leg-wave rig, climbing contacts, and close-view mouth detail. |
| Giant Constrictor Snake | T1 | Serpentine body | R3 | SERPENT, UNDERWATER | ANCHOR=Constrictor Snake base; VARIANT_OF=Constrictor Snake; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Crab | T1 | Arthropod | R3 | UNDERWATER | ANCHOR=Crab base; VARIANT_OF=Crab; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Crocodile | T1 | Crocodilian quadruped | R3 | UNDERWATER | ANCHOR=Crocodile base; VARIANT_OF=Crocodile; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Eagle | T1 | Avian biped | R3 | WING | ANCHOR=Eagle base; VARIANT_OF=Eagle; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Elk | T1 | Ungulate quadruped | R3 | NONE | ANCHOR=Elk base; VARIANT_OF=Elk; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Fire Beetle | T2 | Arthropod | R3 | EMISSIVE | ANCHOR=Fire Beetle base; VARIANT_OF=Fire Beetle; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Frog | T1 | Amphibian quadruped | R3 | UNDERWATER | ANCHOR=Frog base; VARIANT_OF=Frog; DELTA=mass, proportions, webbed contacts, and close-view mouth detail rather than uniform scaling. |
| Giant Goat | T1 | Ungulate quadruped | R3 | NONE | ANCHOR=Goat base; VARIANT_OF=Goat; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Hyena | T1 | Canid quadruped | R3 | NONE | ANCHOR=Hyena base; VARIANT_OF=Hyena; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Lizard | T1 | Lizard quadruped | R3 | NONE | ANCHOR=Lizard base; VARIANT_OF=Lizard; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Octopus | T2 | Cephalopod | R3 | MULTILIMB, TENTACLE, UNDERWATER | ANCHOR=Octopus base; VARIANT_OF=Octopus; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Owl | T1 | Avian biped | R3 | WING | ANCHOR=Owl base; VARIANT_OF=Owl; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Poisonous Snake | T1 | Serpentine body | R3 | SERPENT, UNDERWATER | ANCHOR=Poisonous Snake base; VARIANT_OF=Poisonous Snake; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Rat | T1 | Small mammal quadruped | R3 | NONE | ANCHOR=Rat base; VARIANT_OF=Rat; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Rat (Diseased) | T1 | Small mammal quadruped | R3 | NONE | ANCHOR=Giant Rat; VARIANT_OF=Giant Rat; DELTA=disease lesions, patchy coat, and unhealthy color variation with identical rig and proportions. |
| Giant Scorpion | T2 | Arthropod | R3 | MULTILIMB | ANCHOR=Scorpion base; VARIANT_OF=Scorpion; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Sea Horse | T1 | Aquatic fish | R3 | UNDERWATER | ANCHOR=Sea Horse base; VARIANT_OF=Sea Horse; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Shark | T1 | Fish swimmer | R3 | EXTREME-SCALE, UNDERWATER | ANCHOR=Shark base; VARIANT_OF=Shark; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Spider | T2 | Arachnid | R3 | MULTILIMB | ANCHOR=Spider base; VARIANT_OF=Spider; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Toad | T2 | Amphibian quadruped | R2 | UNDERWATER | ANCHOR=Frog amphibian rig; DELTA=toad proportions, warty skin, heavier jump cycle, swim pose, and swallowing-ready mouth. |
| Giant Vulture | T1 | Avian biped | R3 | WING | ANCHOR=Vulture base; VARIANT_OF=Vulture; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Wasp | T2 | Arthropod | R3 | WING, UNDERWATER | ANCHOR=Wasp base; VARIANT_OF=Wasp; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Weasel | T1 | Small mammal quadruped | R3 | NONE | ANCHOR=Weasel base; VARIANT_OF=Weasel; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Giant Wolf Spider | T2 | Arachnid | R3 | MULTILIMB | ANCHOR=Wolf Spider base; VARIANT_OF=Wolf Spider; DELTA=mass, proportions, and close-view detail rather than uniform scaling. |
| Gibbering Mouther | T4 | Amorphous gibbering mass | R0 | MULTI-FEATURE, DEFORM, UNDERWATER, CONCEPT-SPARSE, ORIGINAL-DESIGN | SYSTEM=deforming ground-hugging mass supporting bite, gibbering, and blinding-spittle cues; choose eye/mouth count and placement through original concepting. |
| Glabrezu | T4 | Four-armed pincer biped | R0 | MULTILIMB | SYSTEM=two pincers plus two hands on one torso; establish arm priority and self-collision rules. |
| Gladiator | T1 | Biped humanoid | R3 | NONE | ANCHOR=Modular humanoid core; DELTA=arena armor, spear, and shield; preserve role readability at token distance. |
| Gnoll | T2 | Bite-capable weapon humanoid | R2 | ORIGINAL-DESIGN | ANCHOR=Humanoid combat rig; DELTA=original head and leg anatomy with bite clearance, spear and bow grips, and a coordinated pack-fighter silhouette. |
| Goat | T1 | Caprine quadruped | R2 | NONE | ANCHOR=Caprine rig; DELTA=split-hoof contacts, horn and forehead collision, compact climbing stance, and a short ram windup. |
| Goblin | T2 | Biped humanoid | R2 | NONE | ANCHOR=Small goblinoid rig; DELTA=compact limbs, quick crouch silhouette, scimitar and shortbow kit, and readable Nimble Escape poses. |
| Gold Dragon Wyrmling | T3 | Winged draconic quadruped | R2 | WING, UNDERWATER | ANCHOR=True-dragon master; VARIANT_OF=Gold dragon age set; DELTA=wyrmling proportions, gold palette/material treatment and breath-effect cues. |
| Gorgon | T3 | Bull-like quadruped | R1 | NONE | ANCHOR=Bull quadruped rig; DELTA=original high-AC surface treatment and petrifying-breath setup; gore, hooves, charge, and breath are established, but metallic armor is not. |
| Gray Ooze | T3 | Amorphous ooze | R1 | DEFORM, TRANSLUCENT | Reuse the ooze shader and deformation cage; keep a low viscous profile with wall adhesion and a clear metal-corrosion contact area. |
| Green Dragon Wyrmling | T3 | Winged draconic quadruped | R2 | WING, UNDERWATER | ANCHOR=True-dragon master; VARIANT_OF=Green dragon age set; DELTA=wyrmling proportions, green palette/material treatment and breath-effect cues. |
| Green Hag | T2 | Biped humanoid | R2 | TRANSFORM, FORM-SCOPE | ANCHOR=Hag humanoid rig; VARIANT_OF=hag family; DELTA=green environment, face, hands, and illusion/shape presentation. |
| Grick | T3 | Tentacled climbing predator | R1 | TENTACLE, CONCEPT-SPARSE, ORIGINAL-DESIGN | Use a flexible body rig; support Tentacles, Beak, and Stone Camouflage, but choose tentacle count/placement and body plan through original concepting. |
| Griffon | T2 | Winged lion-eagle quadruped | R2 | WING | ANCHOR=Winged quadruped rig; DELTA=resolve the eagle-to-lion seam, feathered forequarters, beak, and claw contacts before flight polish. |
| Grimlock | T2 | Biped humanoid | R2 | NONE | ANCHOR=Humanoid cave-dweller rig; DELTA=blind face treatment, enlarged sensory features, spiked bone club, and stone-camouflage breakup. |
| Guard | T1 | Biped humanoid | R3 | NONE | ANCHOR=Modular humanoid core; DELTA=uniform armor, shield, and spear; preserve role readability at token distance. |
| Guardian Naga | T3 | Humanoid-headed serpent | R1 | SERPENT | Reuse a serpentine spline and head rig; prioritize elevated head carriage, poison-spit mouth shapes, and stable casting poses. |
| Gynosphinx | T4 | Winged lion-human hybrid | R0 | WING | SYSTEM=lion body, feathered wings, and feminine human face; share sphinx body while preserving distinct head treatment. |
| Half-Red Dragon Veteran | T2 | Biped humanoid | R2 | NONE | ANCHOR=Veteran humanoid kit; DELTA=draconic head or surface traits, fire-breath mouth shapes, and armor adapted around those features. |
| Harpy | T3 | Winged humanoid | R1 | WING | Reuse a winged-humanoid core; resolve wing-to-arm layout, taloned landing contacts, and a face rig capable of sustained song. |
| Hawk | T1 | Avian biped | R2 | WING | ANCHOR=Raptor flight rig; DELTA=small pointed wings, rapid banking, compact talons, and a keen-sight head pose readable at game scale. |
| Hell Hound | T2 | Canid quadruped | R2 | NONE | ANCHOR=Canid rig; DELTA=infernal hide, heat-safe mouth interior, fire-breath emitter, and a more aggressive pack silhouette. |
| Hezrou | T3 | Heavy claw-and-bite fiend | R1 | ORIGINAL-DESIGN | Reuse heavy-creature controls; prioritize bite/claw reach and Stench readability while choosing mouth, skin, and proportions through original concepting. |
| Hill Giant | T2 | Oversized humanoid biped | R2 | NONE | ANCHOR=Giant humanoid skeleton; VARIANT_OF=giant family; DELTA=hill culture, body proportions, clothing, and signature weapon. |
| Hippogriff | T2 | Winged equine-eagle quadruped | R2 | WING | ANCHOR=Winged equid rig; DELTA=solve eagle forequarters into horse hindquarters, then author beak, claw, hoof, and landing contacts. |
| Hobgoblin | T2 | Biped humanoid | R2 | NONE | ANCHOR=Goblinoid humanoid rig; DELTA=disciplined military armor, longsword and longbow kit, and a formation-readable upright posture. |
| Homunculus | T2 | Tiny flying construct | R1 | FORM-SCOPE, ORIGINAL-DESIGN | Reuse a tiny-creature skeleton; choose original flight anatomy, keep the silhouette readable at token scale, and preserve clear bite range. |
| Horned Devil | T4 | Winged horned biped | R0 | WING | SYSTEM=winged devil with fork, horns, and long tail; reserve clear attack arcs for all appendages. |
| Hunter Shark | T1 | Fish swimmer | R2 | UNDERWATER | ANCHOR=Shark rig; DELTA=large predatory proportions, strong caudal stroke, wide bite arc, and blood-frenzy turn acceleration. |
| Hydra | T5 | Multiheaded reptilian body | R0 | MULTIHEAD, SERPENT, UNDERWATER | SYSTEM=shared neck modules with independent head aim; design detachable/regrowing neck states only if animation scope requires them. |
| Hyena | T1 | Hyaenid feliform quadruped | R0 | NONE | ANCHOR=Hyaenid master; SYSTEM=sloped back, powerful neck and jaw, pacing gait, and coat breakup distinct from all canids. |
| Ice Devil | T4 | Cold-damage bite/claw/tail fiend | R0 | ORIGINAL-DESIGN | SYSTEM=original fiend anatomy supporting bite, claw, tail, and Wall of Ice actions; use a cold-material treatment without assuming insectoid form. |
| Ice Mephit | T2 | Small winged humanoid | R2 | WING, ELEMENTAL | ANCHOR=Mephit winged-small rig; VARIANT_OF=mephit family; DELTA=ice material, breath cues, and death-burst breakup. |
| Imp | T3 | Small winged humanoid | R1 | WING, TRANSFORM, FORM-SCOPE | Reuse a small winged-fiend core; rig the tail sting and invisibility dissolve, then define which beast forms are actually separate assets. |
| Invisible Stalker | T3 | Invisible humanoid volume | R2 | ELEMENTAL, INVISIBLE, CONCEPT-SPARSE | ANCHOR=Elemental humanoid framework; SYSTEM=distortion, particles, and optional editor proxy; gameplay readability is the asset. |
| Iron Golem | T3 | Heavy construct biped | R2 | NONE | ANCHOR=Heavy golem skeleton; VARIANT_OF=golem family; DELTA=iron construction, proportions, damage states, and absorption cues. |
| Jackal | T1 | Canid quadruped | R2 | NONE | ANCHOR=Canid rig; DELTA=slender desert body, large ears, narrow muzzle, quick pack gait, and short bite reach. |
| Killer Whale | T2 | Cetacean swimmer | R2 | UNDERWATER | ANCHOR=Cetacean rig; DELTA=deep torso, dorsal and pectoral fin deformation, tail-driven swim, breaching mass, and bite clearance. |
| Knight | T1 | Biped humanoid | R3 | NONE | ANCHOR=Modular humanoid core; DELTA=plate kit, greatsword, and command details; preserve role readability at token distance. |
| Kobold | T2 | Small weapon humanoid | R2 | ORIGINAL-DESIGN | ANCHOR=Small humanoid rig; DELTA=light frame, original face and skin treatment, dagger and sling grips, and compact pack poses; do not assume reptilian canon. |
| Kraken | T5 | Giant cephalopod | R0 | MULTILIMB, TENTACLE, EXTREME-SCALE, UNDERWATER | SYSTEM=hero cephalopod rig with sucker detail and long-tentacle IK; separate close combat and distant-water LODs. |
| Lamia | T3 | Large clawed spellcaster | R1 | FORM-SCOPE, ORIGINAL-DESIGN | Support claw, dagger, touch, and humanoid-disguise actions with an original body plan; do not assume a lion-human junction. |
| Lemure | T2 | Fist-attacking fiend body | R1 | FORM-SCOPE, ORIGINAL-DESIGN | Choose an original body plan supporting Fist attacks and Hellish Rejuvenation; reuse simple biped controls only if the selected concept warrants them. |
| Lich | T3 | Desiccated humanoid | R1 | NONE | Reuse a skeletal humanoid and robe system; expose durable bone landmarks, preserve spellcasting hands, and build the paralyzing-touch read. |
| Lion | T1 | Feline quadruped | R2 | NONE | ANCHOR=Big-cat rig; DELTA=lion chest and muzzle, optional mane system, pounce compression, and coordinated bite and claw arcs. |
| Lizard | T1 | Small lizard quadruped | R2 | NONE | ANCHOR=Lizard rig; DELTA=sprawled gait, flexible tail, toe placement on climbs, and a tiny bite that remains visible. |
| Lizardfolk | T2 | Biped humanoid | R2 | UNDERWATER | ANCHOR=Reptilian humanoid rig; DELTA=swim-capable tail and hands, bite jaw, plus heavy-club, javelin, and spiked-shield clearance. |
| Mage | T1 | Biped humanoid | R3 | CLOTH | ANCHOR=Modular humanoid core; DELTA=mid-rank robes and dagger; preserve role readability at token distance. |
| Magma Mephit | T2 | Small winged humanoid | R2 | WING, ELEMENTAL | ANCHOR=Mephit winged-small rig; VARIANT_OF=mephit family; DELTA=magma material, breath cues, and death-burst breakup. |
| Magmin | T2 | Small fire-touch elemental | R1 | ELEMENTAL, EMISSIVE, ORIGINAL-DESIGN | Reuse a small-creature rig; create an original emissive material for Touch, Ignited Illumination, and Death Burst without assuming a cracked-rock body. |
| Mammoth | T2 | Proboscidean quadruped | R2 | EXTREME-SCALE | ANCHOR=Elephant proboscidean master; VARIANT_OF=Elephant family; DELTA=cold-adapted mass, long curved tusks, small ears, and layered shaggy grooming. |
| Manticore | T4 | Winged mythic quadruped | R0 | WING, ORIGINAL-DESIGN | SYSTEM=use the public-domain lion-bodied, human-faced manticore core with original flight anatomy and a ranged tail-spike silhouette; avoid a proprietary wing design. |
| Marilith | T5 | Six-armed serpentine humanoid | R0 | MULTILIMB, SERPENT | SYSTEM=six-arm combat hierarchy over a serpentine spine; solve weapon collisions before final topology. |
| Mastiff | T1 | Canid quadruped | R2 | NONE | ANCHOR=Canid rig; DELTA=domestic mastiff chest, jowls and short coat, with alert tracking poses and a forceful bite. |
| Medusa | T3 | Snake-haired humanoid | R1 | NONE | ANCHOR=Humanoid biped; SYSTEM=snake-hair secondary rig and gaze-ready facial rig; cap active snakes for performance. |
| Merfolk | T2 | Aquatic humanoid | R2 | UNDERWATER | ANCHOR=Aquatic humanoid rig; DELTA=streamlined lower body, spear reach, underwater turns, and a credible limited land-support pose. |
| Merrow | T2 | Large aquatic humanoid | R2 | UNDERWATER | ANCHOR=Large aquatic humanoid rig; DELTA=powerful swim silhouette, bite and claw arcs, and a harpoon throw that clears fins and body. |
| Mimic | T3 | Transforming prop-creature | R1 | DEFORM, TRANSFORM, FORM-SCOPE | SYSTEM=choose and document one original object form before modeling; build pseudopod/bite deformation and a controlled reveal transition. |
| Minotaur | T2 | Horned humanoid biped | R1 | NONE | Reuse a powerful humanoid lower rig; build the bull head, horn collision volumes, forward charge posture, and greataxe clearance together. |
| Minotaur Skeleton | T2 | Skeletal biped | R2 | NONE | ANCHOR=Humanoid skeleton rig; DELTA=large horned skull, reinforced ribs and pelvis, plus gore and greataxe ranges without bone collisions. |
| Mule | T1 | Equine quadruped | R2 | NONE | ANCHOR=Equid rig; DELTA=donkey-like ears and head, compact hybrid proportions, sure-footed gait, and pack-load attachment clearance. |
| Mummy | T2 | Corpse humanoid | R1 | NONE | Reuse a corpse biped; place bandage layers across joints with controlled sliding and reserve exposed areas for rot variation. |
| Mummy Lord | T3 | Corpse humanoid | R1 | NONE | Reuse the Mummy body and wrap system; add rank-defining regalia, spellcasting hand freedom, and sand-transition breakup masks. |
| Nalfeshnee | T4 | Flying heavy bite-and-claw fiend | R0 | FORM-SCOPE, ORIGINAL-DESIGN | SYSTEM=original heavy flying fiend supporting bite, claws, Horror Nimbus, and teleport; choose flight anatomy and proportions independently. |
| Night Hag | T3 | Otherworldly humanoid | R2 | TRANSFORM, FORM-SCOPE | ANCHOR=Hag humanoid rig; VARIANT_OF=hag family; DELTA=night environment, face, hands, and illusion/shape presentation. |
| Nightmare | T3 | Supernatural equine quadruped | R1 | ELEMENTAL, EMISSIVE | ANCHOR=Equid rig; DELTA=fire-damage hooves, Ethereal Stride, and supernatural flight; choose any additional flame placement through original concepting. |
| Noble | T1 | Biped humanoid | R3 | CLOTH | ANCHOR=Modular humanoid core; DELTA=tailored court clothes and rapier; preserve role readability at token distance. |
| Ochre Jelly | T3 | Amorphous ooze | R1 | DEFORM, TRANSLUCENT | ANCHOR=Ooze deformation system; VARIANT_OF=Black Pudding family; DELTA=ochre material, lower profile, and split silhouette. |
| Octopus | T2 | Cephalopod | R0 | MULTILIMB, TENTACLE, UNDERWATER | ANCHOR=Cephalopod master; SYSTEM=eight independent arm chains, mantle breathing, sucker LODs, crawling-to-swimming motion, and ink emission. |
| Ogre | T2 | Oversized humanoid biped | R1 | NONE | Reuse an oversized humanoid skeleton; push heavy hands and belly mass while preserving overhead greatclub and javelin ranges. |
| Ogre Zombie | T2 | Corpse humanoid | R2 | NONE | ANCHOR=Ogre body rig; DELTA=collapsed corpse mass, modular decay, dragging morningstar poses, and an Undead Fortitude recovery. |
| Oni | T3 | Oversized humanoid biped | R1 | TRANSFORM, FORM-SCOPE | ANCHOR=Giant biped skeleton; DELTA=horned ogre-like body, glaive-ready hands, and magical-flight presentation without inventing wings; SCOPE=alternate humanoid forms are linked variants. |
| Orc | T2 | Biped humanoid | R2 | NONE | ANCHOR=Robust humanoid rig; DELTA=aggressive forward posture, strong jaw silhouette, greataxe and javelin kit, and sprint-ready armor. |
| Otyugh | T4 | Tentacled aberration body | R0 | MULTILIMB, TENTACLE, CONCEPT-SPARSE, ORIGINAL-DESIGN | SYSTEM=original body plan supporting one bite and two tentacle attacks; prototype locomotion and tentacle IK without assuming a tripod or eyestalk. |
| Owl | T1 | Avian biped | R2 | WING | ANCHOR=Owl flight rig; DELTA=round facial disk, silent broad-wing stroke, extreme head rotation, and compact talon contacts. |
| Owlbear | T2 | Feathered ursine quadruped | R2 | NONE | ANCHOR=Bear quadruped rig; DELTA=owl head, beak, feather-to-fur transition, and foreclaws that support both avian and ursine reads. |
| Panther | T1 | Feline quadruped | R2 | NONE | ANCHOR=Big-cat rig; DELTA=low stalking body, long tail balance, dark short coat, tree-climb contacts, and explosive pounce compression. |
| Pegasus | T2 | Winged equine quadruped | R2 | WING | ANCHOR=Equid rig; DELTA=wing-root shoulder redesign, feather deformation, and believable takeoff, landing, and hoof contacts. |
| Phase Spider | T3 | Arachnid | R1 | MULTILIMB | ANCHOR=Spider rig; SYSTEM=phase dissolve and large-body climb contacts; retain silhouette throughout transition. |
| Pit Fiend | T5 | Flying boss fiend weapon user | R0 | FORM-SCOPE, ORIGINAL-DESIGN | SYSTEM=original boss body supporting flight, bite, claw, mace, and tail actions; decide flight and head anatomy independently and preserve a readable silhouette. |
| Planetar | T4 | Winged humanoid | R0 | WING | SYSTEM=large winged humanoid with cloth, greatsword, and celestial surface language; test feather and garment overlap. |
| Plesiosaurus | T2 | Plesiosaur swimmer | R0 | UNDERWATER | ANCHOR=Plesiosaur master; SYSTEM=four-flipper underwater flight, long-neck steering limits, compact torso roll, and shoreline rest pose. |
| Poisonous Snake | T1 | Serpentine body | R2 | SERPENT, UNDERWATER | ANCHOR=Serpent spline rig; DELTA=slender body, rapid strike compression, fang-ready jaw, and credible ground-to-swim motion. |
| Polar Bear | T1 | Ursine quadruped | R2 | UNDERWATER | ANCHOR=Bear rig; DELTA=longer neck and paws, dense pale double coat, heavy swim stroke, and wet-fur material response. |
| Pony | T1 | Equine quadruped | R2 | NONE | ANCHOR=Equid rig; DELTA=shorter limbs, compact barrel and head, brisk gait, and hoof contacts that do not look like a uniformly scaled horse. |
| Priest | T1 | Biped humanoid | R3 | CLOTH | ANCHOR=Modular humanoid core; DELTA=senior vestments, holy focus, and mace; preserve role readability at token distance. |
| Pseudodragon | T3 | Tiny winged draconic quadruped | R1 | WING | Reuse true-dragon wing and facial controls selectively; keep the tiny body, tail sting, and familiar-scale silhouette bespoke. |
| Purple Worm | T4 | Giant segmented worm | R0 | SERPENT, EXTREME-SCALE | SYSTEM=extreme-scale segmented burrower with mouth and tail stinger; support turning without accordion collapse. |
| Quasit | T3 | Small winged humanoid | R1 | TRANSFORM, FORM-SCOPE | Reuse a small fiend rig; prioritize claw and scare poses, invisibility dissolve, and an explicit asset list for its alternate forms. |
| Quipper | T1 | Small fantasy fish swimmer | R0 | UNDERWATER, CONCEPT-SPARSE, ORIGINAL-DESIGN | ANCHOR=Quipper-specific fish rig; SYSTEM=derive an original compact predator from bite and blood-frenzy stats, with sharp turns and swarm-ready LODs. |
| Rakshasa | T3 | Disguise-using clawed fiend | R1 | ORIGINAL-DESIGN | ANCHOR=Humanoid rig; DELTA=original natural form supporting claw attacks and disguise magic; do not import tiger-headed or reversed-hand canon. |
| Rat | T1 | Rodent quadruped | R2 | NONE | ANCHOR=Rodent rig; DELTA=flexible spine and tail, quick scurry gait, whisker-safe facial motion, and close-ground bite contact. |
| Raven | T1 | Avian biped | R2 | WING | ANCHOR=Corvid flight rig; DELTA=wedge tail, glossy feather breakup, hopping ground gait, beak motion, and mimicry-ready throat movement. |
| Red Dragon Wyrmling | T3 | Winged draconic quadruped | R2 | WING | ANCHOR=True-dragon master; VARIANT_OF=Red dragon age set; DELTA=wyrmling proportions, red palette/material treatment and breath-effect cues. |
| Reef Shark | T1 | Fish swimmer | R2 | UNDERWATER | ANCHOR=Shark rig; DELTA=medium reef-predator proportions, agile turning, compact bite arc, and efficient underwater LOD silhouette. |
| Remorhaz | T4 | Heated burrowing predator | R0 | FORM-SCOPE, EMISSIVE, ORIGINAL-DESIGN | SYSTEM=original large burrower supporting bite, swallow, and Heated Body cues; decide segmentation and limb plan during concepting. |
| Rhinoceros | T1 | Rhinoceros quadruped | R0 | NONE | ANCHOR=Rhinoceros master; SYSTEM=front-heavy mass, horn clearance, thick skin folds, planted feet, and charge-to-gore transition. |
| Riding Horse | T1 | Equine quadruped | R2 | NONE | ANCHOR=Equid rig; DELTA=balanced saddle conformation, medium build, rider attachment points, regular gait set, and clean hoof contacts. |
| Roc | T3 | Giant avian | R1 | WING, EXTREME-SCALE | Reuse a large bird skeleton only as a starting point; redesign feather groups, talon load-bearing, and LODs for gargantuan scale. |
| Roper | T4 | Cave-formation tendril ambusher | R0 | MULTILIMB, TENTACLE, CONCEPT-SPARSE, ORIGINAL-DESIGN | SYSTEM=original body supporting Bite, at least four independently attacking Tendrils, Reel, and a cave-formation false appearance; tendril IK determines topology. |
| Rug of Smothering | T3 | Deforming cloth prop | R2 | DEFORM, CLOTH | ANCHOR=Cloth-prop rig; SYSTEM=rolled, flying, and wrapped poses; cloth simulation needs authored combat fallbacks. |
| Rust Monster | T3 | Antenna-bearing corrosion predator | R1 | FORM-SCOPE, CONCEPT-SPARSE, ORIGINAL-DESIGN | Rig the two Antennae contacts and keep Bite clear; choose limb count and body plan through original concepting. |
| Saber-Toothed Tiger | T1 | Feline quadruped | R2 | NONE | ANCHOR=Big-cat rig; DELTA=reinforced neck and skull, protected saber deformation, heavier forequarters, and pounce-to-bite clearance. |
| Sahuagin | T2 | Aquatic bite-and-claw humanoid | R2 | UNDERWATER, ORIGINAL-DESIGN | ANCHOR=Aquatic humanoid rig; DELTA=original body supporting bite, claws, swim/walk movement, spear grip, and surfaces that read both wet and ashore; choose fin placement independently. |
| Salamander | T3 | Serpentine humanoid | R1 | SERPENT | Combine a humanoid upper body with a serpent spline; coordinate heated plates, spear reach, and tail-constrict deformation. |
| Satyr | T2 | Biped humanoid | R2 | NONE | ANCHOR=Humanoid rig; DELTA=goat-like digitigrade legs, horn and head treatment, ram pose, and shortsword/shortbow clearance. |
| Scorpion | T1 | Scorpion body | R0 | NONE | ANCHOR=Scorpion master; SYSTEM=eight-leg gait, independent pincers, segmented tail curl, and precise sting contact. |
| Scout | T1 | Biped humanoid | R3 | NONE | ANCHOR=Modular humanoid core; DELTA=travel leathers, paired blades, and bow; preserve role readability at token distance. |
| Sea Hag | T2 | Biped humanoid | R2 | UNDERWATER | ANCHOR=Hag humanoid rig; VARIANT_OF=hag family; DELTA=sea environment, face, hands, and illusion/shape presentation. |
| Sea Horse | T1 | Upright seahorse swimmer | R0 | UNDERWATER | ANCHOR=Seahorse-specific rig; SYSTEM=upright body undulation, dorsal-fin propulsion, curled prehensile tail, and tiny-scale silhouette support. |
| Shadow | T3 | Flattened spectral humanoid | R2 | SPECTRAL | ANCHOR=Spectral humanoid system; SYSTEM=flattened shadow volume and strength-drain reach; test on dark ground. |
| Shambling Mound | T3 | Plant-mass humanoid | R1 | DEFORM, FOLIAGE, UNDERWATER, CONCEPT-SPARSE | SYSTEM=layered vegetation mass with engulf deformation; separate rigid branch bones from cheap foliage motion. |
| Shield Guardian | T3 | Armored construct biped | R1 | NONE | Reuse a heavy construct biped; articulate armor gaps for full fist swings and isolate the chest/shield-effect attachment points. |
| Shrieker | T2 | Plant body | R1 | FOLIAGE | Use a static fungal stem rig with cap and gill pulse controls; the false-appearance idle and shriek expansion should share one mesh. |
| Silver Dragon Wyrmling | T3 | Winged draconic quadruped | R2 | WING | ANCHOR=True-dragon master; VARIANT_OF=Silver dragon age set; DELTA=wyrmling proportions, silver palette/material treatment and breath-effect cues. |
| Skeleton | T2 | Skeletal biped | R2 | NONE | ANCHOR=Humanoid skeleton rig; DELTA=stable joint gaps and bone thickness that support both shortsword and shortbow motion. |
| Solar | T4 | Winged humanoid | R0 | WING | SYSTEM=hero winged humanoid with cloth, greatsword, bow, and flying sword; treat weapon/VFX suite as separate deliverables. |
| Specter | T3 | Spectral humanoid | R2 | SPECTRAL, TRANSLUCENT | ANCHOR=Spectral humanoid system; SYSTEM=incorporeal trailing rig and life-drain contact; minimize transparency artifacts. |
| Spider | T1 | Arachnid | R0 | NONE | ANCHOR=Spider master; SYSTEM=eight-leg contact solver, abdomen follow-through, wall-climb orientation, and compact fang strike. |
| Spirit Naga | T3 | Humanoid-headed serpent | R1 | SERPENT | Reuse the Naga body spline; differentiate head, palette, and casting posture while retaining a clean bite arc. |
| Sprite | T2 | Small winged humanoid | R1 | WING | Reuse a tiny humanoid and insect-wing rig; exaggerate weapon thickness, wing motion, and silhouette for miniature-scale readability. |
| Spy | T1 | Biped humanoid | R3 | NONE | ANCHOR=Modular humanoid core; DELTA=civilian disguise layers and concealed weapons; preserve role readability at token distance. |
| Steam Mephit | T2 | Small winged humanoid | R2 | WING, ELEMENTAL | ANCHOR=Mephit winged-small rig; VARIANT_OF=mephit family; DELTA=steam material, breath cues, and death-burst breakup. |
| Stirge | T2 | Flying blood-draining parasite | R1 | FORM-SCOPE, CONCEPT-SPARSE, ORIGINAL-DESIGN | SYSTEM=original flight and feeding anatomy supporting Blood Drain and an attach-to-target pose; choose wings and feeding appendage through concepting. |
| Stone Giant | T2 | Oversized humanoid biped | R2 | NONE | ANCHOR=Giant humanoid skeleton; VARIANT_OF=giant family; DELTA=stone culture, body proportions, clothing, and signature weapon. |
| Stone Golem | T2 | Heavy construct biped | R2 | NONE | ANCHOR=Heavy golem skeleton; VARIANT_OF=golem family; DELTA=stone construction, proportions, damage states, and absorption cues. |
| Storm Giant | T2 | Oversized humanoid biped | R2 | UNDERWATER | ANCHOR=Giant humanoid skeleton; VARIANT_OF=giant family; DELTA=storm culture, body proportions, clothing, and signature weapon. |
| Succubus/Incubus | T3 | Winged humanoid | R1 | WING, TRANSFORM, FORM-SCOPE | ANCHOR=Winged humanoid rig; FORM-SCOPE=decide whether both presentations and humanoid disguises are separate assets. |
| Swarm of Bats | T3 | Instanced flying swarm | R3 | WING, SWARM | ANCHOR=Bat unit rig; VARIANT_OF=shared swarm controller; SYSTEM=3–5 unit variants, instancing, density LOD, and coherent attack flow. |
| Swarm of Beetles | T3 | Instanced crawling swarm | R3 | SWARM | ANCHOR=Beetle unit rig; VARIANT_OF=shared swarm controller; SYSTEM=3–5 unit variants, instancing, density LOD, and coherent attack flow. |
| Swarm of Centipedes | T3 | Instanced crawling swarm | R3 | SWARM | ANCHOR=Centipede unit rig; VARIANT_OF=shared swarm controller; SYSTEM=3–5 unit variants, instancing, density LOD, and coherent attack flow. |
| Swarm of Insects | T3 | Instanced crawling swarm | R3 | SWARM, FORM-SCOPE | ANCHOR=Insect swarm controller; FORM-SCOPE=select one licensed-safe species mix and document it before unit sculpting. |
| Swarm of Poisonous Snakes | T3 | Instanced serpentine swarm | R3 | SWARM, UNDERWATER | ANCHOR=Poisonous Snake unit rig; VARIANT_OF=shared swarm controller; SYSTEM=3–5 unit variants, instancing, density LOD, and coherent attack flow. |
| Swarm of Quippers | T3 | Instanced aquatic swarm | R3 | SWARM, UNDERWATER | ANCHOR=Quipper unit rig; VARIANT_OF=shared swarm controller; SYSTEM=3–5 unit variants, instancing, density LOD, and coherent attack flow. |
| Swarm of Rats | T3 | Instanced crawling swarm | R3 | SWARM | ANCHOR=Rat unit rig; VARIANT_OF=shared swarm controller; SYSTEM=3–5 unit variants, instancing, density LOD, and coherent attack flow. |
| Swarm of Ravens | T3 | Instanced flying swarm | R3 | WING, SWARM | ANCHOR=Raven unit rig; VARIANT_OF=shared swarm controller; SYSTEM=3–5 unit variants, instancing, density LOD, and coherent attack flow. |
| Swarm of Spiders | T3 | Instanced crawling swarm | R3 | SWARM | ANCHOR=Spider unit rig; VARIANT_OF=shared swarm controller; SYSTEM=3–5 unit variants, instancing, density LOD, and coherent attack flow. |
| Swarm of Wasps | T3 | Instanced crawling swarm | R3 | WING, SWARM | ANCHOR=Wasp unit rig; VARIANT_OF=shared swarm controller; SYSTEM=3–5 unit variants, instancing, density LOD, and coherent attack flow. |
| Tarrasque | T5 | Extreme-scale carapaced siege monster | R0 | EXTREME-SCALE, ORIGINAL-DESIGN | SYSTEM=extreme-scale original body plan supporting bite, claws, horns, tail, and swallow staging; build district-view LODs early. |
| Thug | T1 | Biped humanoid | R3 | NONE | ANCHOR=Modular humanoid core; DELTA=heavy street clothes, mace, and crossbow; preserve role readability at token distance. |
| Tiger | T1 | Feline quadruped | R2 | NONE | ANCHOR=Big-cat rig; DELTA=tiger head and shoulder mass, striped groom masks, stalking gait, and pounce-to-bite coordination. |
| Treant | T4 | Tree humanoid | R0 | FOLIAGE | SYSTEM=walkable tree rig with branch arms and foliage cards; build seasonal/material variants from one trunk skeleton. |
| Tribal Warrior | T1 | Biped humanoid | R3 | NONE | ANCHOR=Modular humanoid core; DELTA=light natural-material kit and spear; preserve role readability at token distance. |
| Triceratops | T2 | Ceratopsian quadruped | R0 | NONE | ANCHOR=Ceratopsian master; SYSTEM=beaked head, frill and three-horn clearance, columnar gait, and charge-to-gore weight transfer. |
| Troll | T2 | Oversized humanoid biped | R1 | NONE | Reuse a tall humanoid skeleton; support long claw and bite arcs, sagging mass, and modular wound states for regeneration. |
| Tyrannosaurus Rex | T2 | Theropod biped | R0 | EXTREME-SCALE | ANCHOR=Theropod master; SYSTEM=tail-balanced locomotion, massive jaw and neck, tiny arm constraints, extreme-scale LODs, and bite pickup. |
| Unicorn | T2 | Equine quadruped | R2 | NONE | ANCHOR=Equid rig; DELTA=horned head balance, distinctive mane and hoof treatment, plus clean charge and teleport-effect silhouettes. |
| Vampire, Vampire Form | T3 | Corpse humanoid | R2 | TRANSFORM, FORM-SCOPE | ANCHOR=Vampire linked-form set; VARIANT_OF=primary humanoid form; DELTA=predatory face, claws, bite, and mist-transition topology. |
| Vampire, Bat Form | T3 | Winged mammal | R2 | WING, TRANSFORM, FORM-SCOPE | ANCHOR=Giant Bat rig; VARIANT_OF=Giant Bat; DELTA=predatory proportions and markings tied to Vampire, Vampire Form; SYSTEM=linked form transition. |
| Vampire, Mist Form | T3 | Amorphous mist volume | R2 | DEFORM, TRANSFORM, FORM-SCOPE, SPECTRAL, TRANSLUCENT | ANCHOR=Vampire linked-form set; VARIANT_OF=Vampire, Vampire Form; SYSTEM=mist volume and form transition; no opaque body mesh. |
| Vampire Spawn | T2 | Corpse humanoid | R2 | NONE | ANCHOR=Humanoid vampire rig; DELTA=climbing hands and feet, bite and claw face shapes, pale corpse materials, and regenerative wound masks. |
| Veteran | T1 | Biped humanoid | R3 | NONE | ANCHOR=Modular humanoid core; DELTA=weathered armor and three-weapon loadout; preserve role readability at token distance. |
| Violet Fungus | T2 | Plant body | R1 | FOLIAGE | Reuse procedural fungus materials; rig separate rotting-touch tendrils and preserve a convincing inert mushroom rest pose. |
| Vrock | T4 | Winged avian humanoid | R0 | WING | SYSTEM=avian demon biped with large wings, beak, talons, and spores; test crouch-to-flight transitions. |
| Vulture | T1 | Avian biped | R2 | WING | ANCHOR=Soaring-bird rig; DELTA=broad slotted wings, bald head and hooked beak, hunched ground pose, and low-cost circling flight. |
| Warhorse | T1 | Equine quadruped | R2 | NONE | ANCHOR=Equid rig; DELTA=muscular chest and hindquarters, tack clearance, armored-rider attachment points, and trampling charge gait. |
| Warhorse Skeleton | T2 | Equine quadruped | R2 | NONE | ANCHOR=Equid rig; DELTA=anatomically coherent bone spacing, reinforced joints, and hoof motion without rib or pelvis intersections. |
| Water Elemental | T3 | Fluid humanoid | R2 | DEFORM, ELEMENTAL, TRANSLUCENT, UNDERWATER | ANCHOR=Elemental shader framework; SYSTEM=fluid body, foam accents, and whelm deformation; test transparency sorting. |
| Weasel | T1 | Mustelid quadruped | R2 | NONE | ANCHOR=Mustelid rig; DELTA=long flexible torso, short legs, tail balance, rapid tunnel-like turns, and a close bite. |
| Werebear, Bear Form | T1 | Ursine quadruped | R3 | TRANSFORM, FORM-SCOPE | ANCHOR=Brown Bear; VARIANT_OF=Brown Bear; DELTA=matching scars, palette, and proportions tied to the linked human and hybrid forms. |
| Werebear, Human Form | T1 | Biped humanoid | R3 | TRANSFORM, FORM-SCOPE | ANCHOR=Modular humanoid core; DELTA=identity-specific face, clothing, scars, and palette shared across the bear and hybrid forms. |
| Werebear, Hybrid Form | T3 | Humanoid-animal hybrid biped | R2 | TRANSFORM, FORM-SCOPE | ANCHOR=Lycanthrope hybrid rig; DELTA=custom ursine head, paws, mass, and fur while matching the linked human and bear forms. |
| Wereboar, Boar Form | T1 | Porcine quadruped | R3 | TRANSFORM, FORM-SCOPE | ANCHOR=Boar; VARIANT_OF=Boar; DELTA=matching tusks, scars, palette, and proportions tied to the linked human and hybrid forms. |
| Wereboar, Human Form | T1 | Biped humanoid | R3 | TRANSFORM, FORM-SCOPE | ANCHOR=Modular humanoid core; DELTA=identity-specific face, clothing, scars, and palette shared across the boar and hybrid forms. |
| Wereboar, Hybrid Form | T3 | Humanoid-animal hybrid biped | R2 | TRANSFORM, FORM-SCOPE | ANCHOR=Lycanthrope hybrid rig; DELTA=custom porcine head, tusks, hooves, bristles, and mass while matching the linked forms. |
| Wererat, Human Form | T1 | Biped humanoid | R3 | TRANSFORM, FORM-SCOPE | ANCHOR=Modular humanoid core; DELTA=identity-specific face, clothing, scars, and palette shared across the rat and hybrid forms. |
| Wererat, Hybrid Form | T3 | Humanoid-animal hybrid biped | R2 | TRANSFORM, FORM-SCOPE | ANCHOR=Lycanthrope hybrid rig; DELTA=custom rodent head, tail, claws, and fur while matching the linked human and rat forms. |
| Wererat, Rat Form | T1 | Rodent quadruped | R3 | TRANSFORM, FORM-SCOPE | ANCHOR=Rat; VARIANT_OF=Rat; DELTA=matching scars, coat pattern, and proportions tied to the linked human and hybrid forms. |
| Weretiger, Human Form | T1 | Biped humanoid | R3 | TRANSFORM, FORM-SCOPE | ANCHOR=Modular humanoid core; DELTA=identity-specific face, clothing, scars, and palette shared across the tiger and hybrid forms. |
| Weretiger, Hybrid Form | T3 | Humanoid-animal hybrid biped | R2 | TRANSFORM, FORM-SCOPE | ANCHOR=Lycanthrope hybrid rig; DELTA=custom feline head, claws, tail, and striped fur while matching the linked human and tiger forms. |
| Weretiger, Tiger Form | T1 | Feline quadruped | R3 | TRANSFORM, FORM-SCOPE | ANCHOR=Tiger; VARIANT_OF=Tiger; DELTA=matching scars, stripe pattern, and proportions tied to the linked human and hybrid forms. |
| Werewolf, Human Form | T1 | Biped humanoid | R3 | TRANSFORM, FORM-SCOPE | ANCHOR=Modular humanoid core; DELTA=identity-specific face, clothing, scars, and palette shared across the wolf and hybrid forms. |
| Werewolf, Hybrid Form | T3 | Humanoid-animal hybrid biped | R2 | TRANSFORM, FORM-SCOPE | ANCHOR=Lycanthrope hybrid rig; DELTA=custom canid head, claws, digitigrade legs, and fur while matching the linked human and wolf forms. |
| Werewolf, Wolf Form | T1 | Canid quadruped | R3 | TRANSFORM, FORM-SCOPE | ANCHOR=Wolf; VARIANT_OF=Wolf; DELTA=matching scars, coat pattern, and proportions tied to the linked human and hybrid forms. |
| White Dragon Wyrmling | T3 | Winged draconic quadruped | R2 | WING, UNDERWATER | ANCHOR=True-dragon master; VARIANT_OF=White dragon age set; DELTA=wyrmling proportions, white palette/material treatment and breath-effect cues. |
| Wight | T2 | Corpse humanoid | R1 | NONE | Reuse an armored corpse biped; keep sword, bow, and life-drain hand poses compatible while differentiating it from Zombie. |
| Will-o'-Wisp | T3 | Floating light volume | R2 | SPECTRAL, EMISSIVE, CONCEPT-SPARSE | ANCHOR=Floating-light VFX system; SYSTEM=emissive light volume, shock cue, invisibility transition, and exposure-safe readability; choose secondary shapes independently. |
| Winter Wolf | T2 | Canid quadruped | R2 | NONE | ANCHOR=Canid rig; DELTA=larger snow-adapted body, dense coat, cold-breath emitter, and camouflage-friendly value breakup. |
| Wolf | T1 | Canid quadruped | R2 | NONE | ANCHOR=Canid rig; DELTA=wolf chest, paws, muzzle and coat, pack gait spacing, and bite-driven knockdown pose. |
| Worg | T2 | Canid quadruped | R2 | NONE | ANCHOR=Canid rig; DELTA=heavier head and jaw, longer bite reach, and proportions clearly distinct from Wolf and Dire Wolf. |
| Wraith | T3 | Spectral humanoid | R2 | SPECTRAL, TRANSLUCENT | ANCHOR=Spectral humanoid system; SYSTEM=spectral silhouette and life-drain reach; choose clothing/head treatment independently and differentiate it from Specter. |
| Wyvern | T3 | Winged draconic biped | R1 | WING | Reuse selected dragon wing and facial controls; build a two-legged ground gait and give the long stinger tail an independent attack chain. |
| Xorn | T3 | Burrowing claw-and-bite elemental | R1 | FORM-SCOPE, CONCEPT-SPARSE, ORIGINAL-DESIGN | Prototype an original body plan supporting three claw attacks, one bite, Earth Glide, and Stone Camouflage; attack counts do not establish a three-legged radial anatomy. |
| Young Black Dragon | T4 | Winged draconic quadruped | R2 | WING, UNDERWATER | ANCHOR=True-dragon master; VARIANT_OF=Black dragon age set; DELTA=young proportions, black palette/material treatment and breath-effect cues. |
| Young Blue Dragon | T4 | Winged draconic quadruped | R2 | WING | ANCHOR=True-dragon master; VARIANT_OF=Blue dragon age set; DELTA=young proportions, blue palette/material treatment and breath-effect cues. |
| Young Brass Dragon | T4 | Winged draconic quadruped | R2 | WING | ANCHOR=True-dragon master; VARIANT_OF=Brass dragon age set; DELTA=young proportions, brass palette/material treatment and breath-effect cues. |
| Young Bronze Dragon | T4 | Winged draconic quadruped | R2 | WING, UNDERWATER | ANCHOR=True-dragon master; VARIANT_OF=Bronze dragon age set; DELTA=young proportions, bronze palette/material treatment and breath-effect cues. |
| Young Copper Dragon | T4 | Winged draconic quadruped | R2 | WING | ANCHOR=True-dragon master; VARIANT_OF=Copper dragon age set; DELTA=young proportions, copper palette/material treatment and breath-effect cues. |
| Young Gold Dragon | T4 | Winged draconic quadruped | R2 | WING, UNDERWATER | ANCHOR=True-dragon master; VARIANT_OF=Gold dragon age set; DELTA=young proportions, gold palette/material treatment and breath-effect cues. |
| Young Green Dragon | T4 | Winged draconic quadruped | R2 | WING, UNDERWATER | ANCHOR=True-dragon master; VARIANT_OF=Green dragon age set; DELTA=young proportions, green palette/material treatment and breath-effect cues. |
| Young Red Dragon | T4 | Winged draconic quadruped | R2 | WING | ANCHOR=True-dragon master; VARIANT_OF=Red dragon age set; DELTA=young proportions, red palette/material treatment and breath-effect cues. |
| Young Silver Dragon | T4 | Winged draconic quadruped | R2 | WING | ANCHOR=True-dragon master; VARIANT_OF=Silver dragon age set; DELTA=young proportions, silver palette/material treatment and breath-effect cues. |
| Young White Dragon | T4 | Winged draconic quadruped | R2 | WING, UNDERWATER | ANCHOR=True-dragon master; VARIANT_OF=White dragon age set; DELTA=young proportions, white palette/material treatment and breath-effect cues. |
| Zombie | T2 | Corpse humanoid | R1 | NONE | Reuse a humanoid skeleton and modular clothing; create swappable decay regions, a heavy asymmetric gait, and an Undead Fortitude recovery pose. |
