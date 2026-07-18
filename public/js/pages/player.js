// player.js — player screen (/player): shared-map view (GM-authored terrain is
// view-only), token moving, rulers, and the character-sheet HUD (Character /
// Inventory / Spells / Actions panels). Scene boilerplate, meshes and the ruler
// tool live in ../shared/.

import * as THREE from 'three';
import { loadSRD, ABILITIES, abilityMod, fmtMod, proficiencyBonus } from '../shared/srd.js';
import { Terrain } from '../shared/terrain.js';
import { Grass } from '../shared/grass.js';
import { Trees } from '../shared/trees.js';
import { createTabletopScene, startRenderLoop, castFromPointer, snapToGrid, trackRightDrag, styleGroundForTerrain, buildBoundsRect, updateWorldFollow, setWorldOriginAt, maybeRebaseWorld, FOG_NEAR, FOG_FAR, GRID_CELL_SIZE, FEET_PER_GRID_CELL } from '../shared/scene.js';
import { defaultMaterial, selectedMaterial, buildObjectFromData, applyMove } from '../shared/models.js';
import { RulerTool } from '../shared/rulers.js';
import { bindLongPress, dismissSubmenusOnOutsideClick } from '../shared/ui.js';
import { setupLoginModal } from '../shared/login.js';
import { CombatTracker, CombatOverlays, deriveCombatStats, remainingFeet } from '../shared/combat.js';

let terrain = null; // tactical terrain (heightmap + water), GM-authored, view-only here
let grass = null;   // instanced ground-cover grass (shared/grass.js)
let trees = null;   // procedural low-poly trees (shared/trees.js)

// --- Character sheet state ---
let SRD = null;
let pendingHomebrew = null;
let myCharacters = [];
let activeCharId = null;
const hpState = {}; // charId -> current HP (mirrors the server, kept in sync)
const escHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let scene, camera, renderer, controls, plane, grid, raycaster, mouse, dirLight, worldGroup;
let ruler;
let objects = [];
let selectedObject = null;

let socket = null; // created on login
let myUsername = null;

// --- Combat mode (server-authoritative, synced via combat-updated) ---
let combatState = null;
let combatTracker = null;
let pendingAttack = null;       // { combatantId, attackIndex } while picking a target
let dragStartPos = null;        // selected token's world position when the move began
let combatOverlays = null;      // turn/range rings + effect badges (created in init)
let closeAllPanels = () => {};  // assigned in init (needs the HUD overlay refs)

let currentTool = null;
let currentMoveMode = 'standard';
let toolMenuButtons = {};
let moveSubMenuButtons = {};
let moveSubMenu;
let isDraggingHeight = false;

let rulerSubMenu, rulerSubMenuButtons = {};
let rulerSnapSubMenuButtons = {};
let wasRightDrag = null; // right-drag orbits the camera; see trackRightDrag
let boundsRect = null;   // pocket-map boundary rectangle
let currentMapKey = 'world'; // players travel between maps via portals
let terrainIsUnified = false; // is the loaded terrain the shared continuous world?
let hexTree = {};            // GM biome tags (generator overrides), synced via map-state
let regenTimer = null;       // debounce for biome-driven regeneration

const emitRuler = (data) => { if (socket) socket.emit('add-ruler', data); };

function init() {
    ({ scene, camera, renderer, controls, plane, grid, raycaster, mouse, dirLight, worldGroup } =
        createTabletopScene(document.getElementById('scene-container')));

    // Tactical terrain (GM-authored heightmap + water); hidden until a terrain arrives.
    terrain = new Terrain();
    terrain.group.visible = false;
    scene.add(terrain.group);
    grass = new Grass(terrain, scene);   // ground-cover, shown only at tactical zoom
    trees = new Trees(terrain, scene);   // biome-scattered low-poly trees

    ruler = new RulerTool({
        scene: worldGroup, // ruler points/segments are world coords
        tooltip: document.getElementById('ruler-tooltip')
    });

    combatOverlays = new CombatOverlays({
        worldGroup,
        findMesh: findObjectMesh,
        feetToWorld: ft => (ft / FEET_PER_GRID_CELL) * GRID_CELL_SIZE
    });

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('contextmenu', onContextMenu);
    renderer.domElement.addEventListener('dblclick', onDoubleClick); // portal travel
    window.addEventListener('keydown', onKeyDown);
    wasRightDrag = trackRightDrag(renderer.domElement);

    // --- Tool Menu Listeners (Left) ---
    toolMenuButtons.move = document.getElementById('btn-tool-move');
    toolMenuButtons.ruler = document.getElementById('btn-tool-ruler');
    moveSubMenu = document.getElementById('move-submenu');
    moveSubMenuButtons.standard = document.getElementById('btn-move-standard');
    moveSubMenuButtons.x = document.getElementById('btn-move-x');
    moveSubMenuButtons.z = document.getElementById('btn-move-z');
    moveSubMenuButtons.y = document.getElementById('btn-move-y');

    bindLongPress(toolMenuButtons.move, {
        onShortPress: () => setMoveMode('standard'),
        onLongPress: () => { moveSubMenu.style.display = 'block'; }
    });
    moveSubMenuButtons.standard.addEventListener('click', () => setMoveMode('standard'));
    moveSubMenuButtons.x.addEventListener('click', () => setMoveMode('x-only'));
    moveSubMenuButtons.z.addEventListener('click', () => setMoveMode('z-only'));
    moveSubMenuButtons.y.addEventListener('click', () => setMoveMode('y-only'));

    rulerSubMenu = document.getElementById('ruler-submenu');
    rulerSubMenuButtons.straight = document.getElementById('btn-ruler-straight');
    rulerSubMenuButtons.curved = document.getElementById('btn-ruler-curved');

    bindLongPress(toolMenuButtons.ruler, {
        onShortPress: () => setRulerMode(ruler.mode),
        onLongPress: () => { rulerSubMenu.style.display = 'block'; }
    });
    rulerSubMenuButtons.straight.addEventListener('click', () => setRulerMode('straight'));
    rulerSubMenuButtons.curved.addEventListener('click', () => setRulerMode('curved'));

    rulerSnapSubMenuButtons.center = document.getElementById('btn-ruler-snap-center');
    rulerSnapSubMenuButtons.corner = document.getElementById('btn-ruler-snap-corner');
    rulerSnapSubMenuButtons.center.addEventListener('click', () => setRulerSnapMode('center'));
    rulerSnapSubMenuButtons.corner.addEventListener('click', () => setRulerSnapMode('corner'));

    document.querySelectorAll('#ruler-colors .color-swatch').forEach(swatch => {
        swatch.addEventListener('click', (e) => setRulerColor(e.target.dataset.color, e.target));
    });

    dismissSubmenusOnOutsideClick([
        [moveSubMenu, toolMenuButtons.move],
        [rulerSubMenu, toolMenuButtons.ruler]
    ]);

    // --- HUD panel logic ---
    const hudOverlay = document.getElementById('hud-panel-overlay');
    const hudButtons = document.querySelectorAll('#player-hud .hud-button');
    const closeButtons = document.querySelectorAll('.close-panel-btn');

    hudButtons.forEach(button => {
        button.addEventListener('click', () => {
            const panelId = button.dataset.panel;
            document.querySelectorAll('.hud-panel').forEach(p => p.classList.add('hidden'));

            renderHUD(); // refresh sheet from latest character data

            // Show overlay: must drop the `hidden` class (display:none !important)
            // AND set display, since the class would otherwise override the inline style.
            hudOverlay.classList.remove('hidden');
            hudOverlay.style.display = 'flex';
            document.getElementById(panelId).classList.remove('hidden');
        });
    });

    closeAllPanels = function () {
        hudOverlay.classList.add('hidden');
        hudOverlay.style.display = 'none';
        document.querySelectorAll('.hud-panel').forEach(p => p.classList.add('hidden'));
    };

    document.getElementById('btn-end-turn').addEventListener('click', () => {
        if (socket) socket.emit('combat-end-turn', {});
    });

    closeButtons.forEach(btn => btn.addEventListener('click', closeAllPanels));
    hudOverlay.addEventListener('click', (e) => {
        if (e.target === hudOverlay) closeAllPanels();
    });

    startRenderLoop({
        renderer, scene, camera, controls,
        onTick: () => {
            updateWorldFollow({ plane, grid, dirLight, camera }, controls.target); // ground/shadows follow
            if (combatOverlays) combatOverlays.tick(); // rings/badges track their tokens
            if (!terrain) return;
            terrain.tick(performance.now() / 1000);                       // water animation
            if (terrain.group.visible) updateTerrainLOD();                 // detailed chunks vs summary
        }
    });
    // The map arrives from the server once the player logs in (see initSocket).
}

// LOD (U3): nested lit 3D rings under the fine chunks on the unified world;
// zooming out reveals more 3D world. Mirrors gm.js.
function updateTerrainLOD() {
    // Floating origin: slide the world under the camera when it wanders too far
    // for float32 (players free-roam the unified world too).
    if (terrainIsUnified) maybeRebaseWorld({ terrain, worldGroup, camera, controls });
    const dist = camera.position.distanceTo(controls.target);
    // Wheel zoom spans grass level to survey altitude — scale the speed with
    // distance (log) so the trip doesn't take hundreds of ticks while close-up
    // stays precise. Mirrors gm.js.
    controls.zoomSpeed = Math.min(4, Math.max(1, 0.8 + Math.log10(Math.max(1, dist / 25))));
    // Frustum follows zoom (mirrors gm.js): survey altitude needs a far plane
    // millions of units out, tactical work needs near=0.1. Only touch the
    // camera on real change — updateProjectionMatrix isn't free.
    const near = Math.max(0.1, Math.min(2000, dist * 0.002));
    const far = Math.max(40000, dist * 8);
    if (near < camera.near * 0.7 || near > camera.near * 1.4 ||
        far > camera.far * 1.4 || far < camera.far * 0.7) {
        camera.near = near; camera.far = far;
        camera.updateProjectionMatrix();
    }
    // The backdrop plane doubles as the ground-pick target (token moves,
    // rulers): scale it with zoom so rays from any screen point still hit it.
    plane.scale.setScalar(Math.max(1, (dist * 3) / 2000));
    terrain.setGridFade(1 - Math.max(0, Math.min(1, (dist - 15) / (40 - 15))));
    // Terrain streaming/LOD centers are world coords; the camera target is scene.
    const worldTarget = { x: controls.target.x + terrain.worldOrigin.x,
                          z: controls.target.z + terrain.worldOrigin.z };
    terrain.updateWindow(worldTarget);
    if (terrainIsUnified) {
        terrain.setLODVisible(true);
        terrain.setOceanEnabled(true);
        terrain.updateLODRings(worldTarget);
        plane.visible = false;
        scene.fog.near = Math.max(FOG_NEAR, dist * 1.5);
        scene.fog.far = Math.max(FOG_FAR, dist * 6);
    } else {
        terrain.setLODVisible(false);
        terrain.setOceanEnabled(false);
        scene.fog.near = FOG_NEAR;
        scene.fog.far = FOG_FAR;
    }
    if (grass) grass.update(camera, controls, terrainIsUnified);
    if (trees) trees.update(camera, controls, terrainIsUnified);
}

function onPointerDown(event) {
    // Left button = tools; right/middle = camera (OrbitControls).
    if (event.button !== 0) return;

    if (isDraggingHeight) {
        isDraggingHeight = false;
        deselectObject();
        return;
    }

    castFromPointer(event, { renderer, camera, raycaster, mouse });
    const allObjects = [plane, ...objects];
    const intersects = raycaster.intersectObjects(allObjects, true);
    if (intersects.length === 0) return;

    const firstIntersect = intersects[0];
    let topLevelObject = firstIntersect.object;
    while (topLevelObject.parent && topLevelObject.parent !== scene && topLevelObject.parent !== worldGroup) {
        topLevelObject = topLevelObject.parent;
    }
    const clickedObject = objects.find(obj => obj === topLevelObject);

    // GM-built walls/floors are scenery to players: clicks on them read as
    // ground (drop a move on a floor, measure across a room), never selection.
    const clickedType = clickedObject && clickedObject.userData.objectType;
    const buildAsGround = clickedType === 'wall' || clickedType === 'floor';

    // Combat: with an attack pending, this click picks the target instead.
    if (pendingAttack) {
        const targetId = clickedObject && clickedObject.userData.syncId;
        if (targetId && combatState && combatState.combatants[targetId] && socket) {
            socket.emit('combat-action', {
                combatantId: pendingAttack.combatantId, kind: 'attack',
                targetId, attackIndex: pendingAttack.attackIndex
            });
        } else if (combatTracker) {
            combatTracker.flash('Attack cancelled — that was not a combatant');
        }
        pendingAttack = null;
        return;
    }

    if (clickedObject && !buildAsGround) {
        // Combat: combatant tokens are locked to their owner, on their turn.
        const deny = combatSelectDenied(clickedObject);
        if (deny) { if (combatTracker) combatTracker.flash(deny); return; }
        if (currentTool === 'move' && currentMoveMode === 'y-only') {
            selectObject(clickedObject);
            isDraggingHeight = true;
        } else {
            if (selectedObject === clickedObject) {
                deselectObject();
            } else {
                selectObject(clickedObject);
            }
        }
    } else if (firstIntersect.object.name === "tabletop" || buildAsGround) {
        const intersectPoint = sceneToWorld(firstIntersect.point);

        switch (currentTool) {
            case 'move':
                if (selectedObject) {
                    // Emit the move to the server (shared map)
                    const docId = selectedObject.userData.syncId;
                    if (docId && socket) {
                        const finalPosition = snapToGrid(selectedObject.position);
                        socket.emit('move-object', {
                            id: docId,
                            position: {
                                x: finalPosition.x,
                                y: selectedObject.position.y, // keep current height
                                z: finalPosition.z
                            }
                        });
                    }
                    focusCameraOn(selectedObject.position);
                    deselectObject();
                }
                break;
            case 'ruler':
                ruler.click(ruler.snap(intersectPoint), emitRuler);
                break;
        }
    }
}

function onPointerMove(event) {
    ruler.trackMouse(event);

    if (isDraggingHeight && selectedObject) {
        const deltaY = event.movementY * -0.01;
        selectedObject.position.y += deltaY;
        const halfHeight = selectedObject.userData.halfHeight || 0;
        if (selectedObject.position.y < halfHeight) {
            selectedObject.position.y = halfHeight;
        }
        return;
    }

    castFromPointer(event, { renderer, camera, raycaster, mouse });
    const intersects = raycaster.intersectObject(plane);
    if (intersects.length === 0) return;
    const intersectPoint = sceneToWorld(intersects[0].point);

    if (currentTool === 'move' && selectedObject) {
        // Players keep the object's current height, clamped above the ground.
        applyMove(selectedObject, snapToGrid(intersectPoint), currentMoveMode,
            (x, z, halfHeight, currentY) => Math.max(currentY, halfHeight));
        updateMoveCostTooltip(event); // combat: live «X ft — Y ft left»
    }

    if (currentTool === 'ruler' && ruler.points.length > 0) {
        const previewPoints = [...ruler.points, ruler.snap(intersectPoint)];
        ruler.updatePreview(previewPoints);
        ruler.updateTooltip(previewPoints, false);
    } else if (currentTool === 'ruler') {
        ruler.updateTooltip([], false, true); // show "0 ft" at the cursor
    }
}

// Double-click a portal to travel to its target map (the server sends the new
// map-state back; players navigate the world exclusively through portals).
function onDoubleClick(event) {
    castFromPointer(event, { renderer, camera, raycaster, mouse });
    const hit = raycaster.intersectObjects(objects, true)[0];
    if (!hit) return;
    let top = hit.object;
    while (top.parent && top.parent !== scene && top.parent !== worldGroup) top = top.parent;
    const obj = objects.find(o => o === top);
    if (obj && obj.userData.objectType === 'portal' && obj.userData.portalTarget && socket) {
        currentMapKey = obj.userData.portalTarget;
        socket.emit('join-map', { key: currentMapKey });
        // Fresh map, fresh viewpoint.
        controls.target.set(0, 0, 0);
        camera.position.set(20, 30, 20);
    }
}

function onContextMenu(event) {
    event.preventDefault();
    if (wasRightDrag && wasRightDrag(event)) return; // right-drag = camera orbit, not a click
    if (currentTool !== 'ruler') return;
    castFromPointer(event, { renderer, camera, raycaster, mouse });
    const intersects = raycaster.intersectObject(plane);
    if (intersects.length > 0) {
        ruler.restartAt(ruler.snap(sceneToWorld(intersects[0].point)), emitRuler);
    }
}

function onKeyDown(event) {
    // No delete for players
    if (event.key === "Escape") {
        if (pendingAttack) {
            pendingAttack = null;
            if (combatTracker) combatTracker.flash('Attack cancelled');
            return;
        }
        if (currentTool === 'ruler' && ruler.points.length > 0) {
            ruler.clearInProgress();
        } else if (isDraggingHeight) {
            isDraggingHeight = false;
            deselectObject();
        } else if (selectedObject) {
            deselectObject();
        }
    }
}

// Scene <-> world conversion at the raycast/camera boundary (floating origin).
function sceneToWorld(p) {
    return new THREE.Vector3(p.x + terrain.worldOrigin.x, p.y, p.z + terrain.worldOrigin.z);
}
function focusCameraOn(worldPos) {
    controls.target.set(worldPos.x - terrain.worldOrigin.x, worldPos.y, worldPos.z - terrain.worldOrigin.z);
}

// --- Object Management ---
function createObjectFromData(id, data) {
    const mesh = buildObjectFromData(id, data);
    if (mesh) {
        worldGroup.add(mesh); // synced positions are world coords
        objects.push(mesh);
    }
}

function selectObject(object) {
    deselectObject();
    selectedObject = object;
    dragStartPos = object.position.clone(); // combat movement is measured from here
    if (!selectedObject.userData.characterData) {
        selectedObject.material = selectedMaterial;
    }
}

function deselectObject() {
    if (selectedObject && !selectedObject.userData.characterData) {
        if (!selectedObject.material) {
            selectedObject.material = defaultMaterial.clone();
        } else {
            selectedObject.material = defaultMaterial;
        }
    }
    selectedObject = null;
    dragStartPos = null;
    hideMoveTooltip();
}

// --- Combat mode -------------------------------------------------------------

function findObjectMesh(id) { return objects.find(o => o.userData.syncId === id); }
const combatantDown = c => (c.effects || []).some(e => e.key === 'down');

// Why a click on a token is refused during combat (null = allowed).
function combatSelectDenied(obj) {
    if (!combatState || !combatState.started) return null;
    const c = combatState.combatants[obj.userData.syncId];
    if (!c) return null; // not a combatant: moves freely
    if (c.owner !== myUsername) return `You don't control ${c.name}`;
    if (combatState.activeId !== c.id) return `Not ${c.name}'s turn`;
    if (combatantDown(c)) return `${c.name} is down`;
    return null;
}

// Every combat-updated re-applies the whole state: tracker, overlays, HUD.
function setCombat(combat) {
    combatState = combat;
    if (combatTracker) combatTracker.setState(combat);
    answerStatsPending();
    if (combatOverlays) combatOverlays.sync(combat);
    renderHUD(); // the Actions panel reflects turn state
    const endBtn = document.getElementById('btn-end-turn');
    if (endBtn) {
        const active = combat && combat.started && combat.combatants[combat.activeId];
        endBtn.classList.toggle('hidden', !(active && active.owner === myUsername));
    }
    if (!combat) { pendingAttack = null; hideMoveTooltip(); }
}

// Character combatants join with statsPending: their owner's client answers
// with SRD-derived numbers (first write wins server-side). answeredStats stops
// re-sends while our write is still in flight.
const answeredStats = new Set();
function answerStatsPending() {
    if (!combatState || !SRD || !socket) return;
    for (const c of Object.values(combatState.combatants)) {
        if (!c.statsPending || c.owner !== myUsername || !c.charId || answeredStats.has(c.id)) continue;
        const char = myCharacters.find(x => x.id === c.charId);
        if (!char) continue;
        answeredStats.add(c.id);
        socket.emit('combat-set-stats', { combatantId: c.id, ...deriveCombatStats(char, SRD) });
    }
}

function beginTargetPick(combatantId, attackIndex, attack) {
    pendingAttack = { combatantId, attackIndex };
    closeAllPanels();
    if (combatTracker) combatTracker.flash(`Pick a target for ${attack.name}: click a token (Esc cancels)`);
}

// Live «12 ft — 18 ft left» while dragging the active combatant. Reuses the
// ruler tooltip element (move and ruler tools are mutually exclusive).
function updateMoveCostTooltip(event) {
    if (!dragStartPos || !selectedObject || !combatState || !combatState.started) return;
    const c = combatState.combatants[selectedObject.userData.syncId];
    if (!c || combatState.activeId !== c.id) return;
    const el = document.getElementById('ruler-tooltip');
    if (!el) return;
    const feet = Math.hypot(selectedObject.position.x - dragStartPos.x,
        selectedObject.position.z - dragStartPos.z) / GRID_CELL_SIZE * FEET_PER_GRID_CELL;
    const left = c.speedFeet + c.dashFeet - c.movementUsedFeet;
    el.textContent = `${Math.round(feet)} ft — ${Math.max(0, Math.round(left - feet))} ft left`;
    el.style.color = feet > left + 0.5 ? '#ff6b6b' : '';
    el.style.display = 'block';
    el.style.left = (event.clientX + 14) + 'px';
    el.style.top = (event.clientY + 14) + 'px';
}

function hideMoveTooltip() {
    if (currentTool === 'ruler') return; // the ruler owns the tooltip right now
    const el = document.getElementById('ruler-tooltip');
    if (el) { el.style.display = 'none'; el.style.color = ''; }
}

// --- Character sheet HUD rendering ---
function activeChar() {
    return myCharacters.find(c => c.id === activeCharId) || myCharacters[0] || null;
}

function deriveSheet(char) {
    const base = char.abilities || char.stats || { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
    const classes = char.classes || [];
    const finals = SRD.finalAbilities(base, char.race, char.subrace, char.racialChoice || []);
    const mods = {}; for (const a of ABILITIES) mods[a] = abilityMod(finals[a]);
    const total = SRD.totalLevel(classes);
    const prof = proficiencyBonus(total);
    const saves = SRD.saveProficiencies(classes);
    const granted = new Set([...SRD.raceSkillGrants(char.race).fixed, ...SRD.backgroundSkillGrants(char.background)]);
    const proficient = new Set([...granted, ...(char.skills || [])]);
    const maxHP = SRD.maxHP(classes, mods.con);
    const eq = char.equipment || {};
    const acInfo = SRD.armorClass({ armorIdx: eq.armor, shield: eq.shield, dexMod: mods.dex, classes, conMod: mods.con, wisMod: mods.wis });
    const spellInfo = SRD.spellSlots(classes);
    spellInfo.casters.forEach(c => { c.dc = 8 + prof + (mods[c.ability] || 0); c.atk = prof + (mods[c.ability] || 0); });
    const pp = 10 + mods.wis + (proficient.has('perception') ? prof : 0);
    return { base, finals, mods, total, prof, saves, proficient, maxHP,
        ac: acInfo.ac, acSource: acInfo.source, spellInfo, speed: SRD.speed(char.race), init: mods.dex, pp };
}

// Current HP is server-persisted: seed from the character's stored hp.current
// (falling back to full HP), and push every change back to the server.
function getCurrentHP(char, maxHP) {
    if (hpState[char.id] == null) {
        hpState[char.id] = (char.hp && typeof char.hp.current === 'number')
            ? Math.min(char.hp.current, maxHP) : maxHP;
    }
    return Math.max(0, Math.min(hpState[char.id], maxHP));
}
function setCurrentHP(char, value, maxHP) {
    const v = Math.max(0, Math.min(Math.round(value), maxHP));
    hpState[char.id] = v;
    if (char.hp) char.hp.current = v; else char.hp = { current: v };
    if (socket) socket.emit('update-hp', { id: char.id, current: v });
}

function renderHUD() {
    const cc = document.getElementById('char-content');
    const ic = document.getElementById('inv-content');
    const sc = document.getElementById('spells-content');
    const ac = document.getElementById('actions-content');
    if (!cc) return;
    if (!SRD) { const m = '<p class="muted">Loading character data…</p>'; cc.innerHTML = ic.innerHTML = sc.innerHTML = ac.innerHTML = m; return; }
    const char = activeChar();
    if (!char) {
        const m = '<p class="muted">No character is assigned to you yet. Build one in the Character Creator (the “/” page) and it will appear here.</p>';
        cc.innerHTML = ic.innerHTML = sc.innerHTML = ac.innerHTML = m;
        document.getElementById('char-title').textContent = 'Character';
        return;
    }
    const d = deriveSheet(char);
    renderCharPanel(char, d);
    renderInvPanel(char, d);
    renderSpellsPanel(char, d);
    renderActionsPanel(char, d);
}

function selectorHTML(activeId) {
    if (myCharacters.length <= 1) return '';
    const opts = myCharacters.map(c => `<option value="${escHtml(c.id)}" ${c.id === activeId ? 'selected' : ''}>${escHtml(c.name || 'Unnamed')}</option>`).join('');
    return `<select id="char-select" class="char-select">${opts}</select>`;
}

function renderCharPanel(char, d) {
    const cc = document.getElementById('char-content');
    const cur = getCurrentHP(char, d.maxHP);
    const pct = d.maxHP > 0 ? Math.round((cur / d.maxHP) * 100) : 0;
    const race = SRD.get('races', char.race);
    const sub = char.subrace && SRD.get('subraces', char.subrace);
    const classTxt = (char.classes || []).map(c => {
        const cl = SRD.get('classes', c.class); const s = c.subclass && SRD.get('subclasses', c.subclass);
        return `${escHtml(cl ? cl.name : c.class)} ${c.level}${s ? ` (${escHtml(s.name)})` : ''}`;
    }).join(' / ') || '—';
    document.getElementById('char-title').innerHTML = `${escHtml(char.name || 'Unnamed')} <span class="sheet-sub">${escHtml(sub ? sub.name : (race ? race.name : ''))} · ${classTxt}</span>`;

    const metrics = [
        ['HP', `${cur}/${d.maxHP}`], ['AC', d.ac], ['Speed', d.speed],
        ['Init', fmtMod(d.init)], ['Prof', fmtMod(d.prof)], ['PP', d.pp]
    ].map(([l, v]) => `<div class="metric-card"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('');

    const abilities = ABILITIES.map(a => {
        const isSave = d.saves.has(a);
        return `<div class="ability-cell"><div class="ab-name">${a.toUpperCase()}</div><div class="ab-score">${d.finals[a]}</div><div class="ab-mod">${fmtMod(d.mods[a])}</div><div class="ab-save">save ${fmtMod(d.mods[a] + (isSave ? d.prof : 0))}${isSave ? ' ✓' : ''}</div></div>`;
    }).join('');

    const skills = SRD.skills.slice().sort((a, b) => a.name.localeCompare(b.name)).map(sk => {
        const ab = sk.ability_score.index;
        const isProf = d.proficient.has(sk.index);
        const bonus = d.mods[ab] + (isProf ? d.prof : 0);
        return `<div class="row-item"><span>${isProf ? '●' : '<span style="color:#555">○</span>'} ${escHtml(sk.name)} <span class="tag">${ab}</span></span><b>${fmtMod(bonus)}</b></div>`;
    }).join('');

    cc.innerHTML = `${selectorHTML(char.id)}
        <div class="metrics-row">${metrics}</div>
        <div class="stat-bar-group">
            <label>Hit Points</label>
            <div class="stat-bar-outer"><div class="stat-bar-inner" style="width:${pct}%; background-color:${pct < 30 ? '#d14444' : (pct < 60 ? '#d1a544' : '#44d17a')};"></div></div>
            <span>${cur} / ${d.maxHP}</span>
            <div class="hp-controls">
                <button class="dmg" data-hp="-5">−5</button>
                <button class="dmg" data-hp="-1">−1</button>
                <button class="heal" data-hp="1">+1</button>
                <button class="heal" data-hp="5">+5</button>
                <button data-hp="full">Full</button>
            </div>
        </div>
        <h4>Abilities</h4>
        <div class="ability-grid">${abilities}</div>
        <h4>Skills</h4>
        ${skills}`;

    const sel = document.getElementById('char-select');
    if (sel) sel.onchange = e => { activeCharId = e.target.value; renderHUD(); };
    cc.querySelectorAll('.hp-controls button').forEach(btn => btn.onclick = () => {
        const v = btn.dataset.hp;
        if (v === 'full') setCurrentHP(char, d.maxHP, d.maxHP);
        else setCurrentHP(char, getCurrentHP(char, d.maxHP) + (+v), d.maxHP);
        renderCharPanel(char, d);
    });
}

function renderInvPanel(char, d) {
    const ic = document.getElementById('inv-content');
    const eq = char.equipment || {};
    const armor = eq.armor ? SRD.get('equipment', eq.armor) : null;
    const armorTxt = armor ? armor.name : 'None';
    const weapons = (eq.weapons || []).map(wi => {
        const w = SRD.get('equipment', wi); if (!w) return '';
        const a = SRD.weaponAttack(w, d.mods, char.classes || [], d.prof);
        return `<div class="row-item"><span>${escHtml(w.name)} <span class="tag">${a.ranged ? 'ranged ' + a.range : 'melee'}</span></span><b>${fmtMod(a.attack)} · ${a.damage}${a.versatile ? ' (' + a.versatile + ' 2H)' : ''} ${escHtml(a.damageType)}</b></div>`;
    }).join('') || '<p class="muted">No weapons.</p>';
    const gear = (eq.items || []).map(gi => SRD.get('equipment', gi)).filter(Boolean)
        .map(g => `<div class="row-item"><span>${escHtml(g.name)}</span></div>`).join('') || '<p class="muted">No gear.</p>';
    ic.innerHTML = `
        <h4>Armor</h4>
        <div class="row-item"><span>${escHtml(armorTxt)}${eq.shield ? ' + Shield' : ''}</span><b>AC ${d.ac}</b></div>
        <div class="muted" style="margin-top:4px;">${escHtml(d.acSource)}</div>
        <h4>Weapons</h4>${weapons}
        <h4>Gear</h4>${gear}`;
}

function renderSpellsPanel(char, d) {
    const sc = document.getElementById('spells-content');
    const casters = (char.classes || []).filter(c => SRD.isCaster(c.class));
    if (!casters.length) { sc.innerHTML = '<p class="muted">This character has no spellcasting classes.</p>'; return; }
    const si = d.spellInfo;
    const slotLine = Object.entries(si.slots).filter(([l, n]) => n > 0).map(([l, n]) => `L${l}×${n}`).join('  ·  ');
    const pactLine = si.pact ? `Pact ${si.pact.count}×L${si.pact.level}` : '';
    const casterSummary = si.casters.map(ci => {
        const cl = SRD.get('classes', ci.class);
        return `<div class="row-item"><span>${escHtml(cl ? cl.name : ci.class)} <span class="tag">${ci.ability ? ci.ability.toUpperCase() : ''}</span></span><b>DC ${ci.dc} · atk ${fmtMod(ci.atk)}</b></div>`;
    }).join('');
    const known = (char.spells || []).map(x => SRD.get('spells', x)).filter(Boolean).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
    const byLevel = {};
    known.forEach(s => { (byLevel[s.level] = byLevel[s.level] || []).push(s); });
    const spellSections = Object.keys(byLevel).map(Number).sort((a, b) => a - b).map(lv => {
        const label = lv === 0 ? 'Cantrips' : `Level ${lv}`;
        const items = byLevel[lv].map(s => `<div class="row-item"><span>${escHtml(s.name)}${s.concentration ? ' <span class="tag">C</span>' : ''}${s.ritual ? ' <span class="tag">R</span>' : ''}</span></div>`).join('');
        return `<details class="spell-lvl" open><summary>${label} <span class="muted">(${byLevel[lv].length})</span></summary>${items}</details>`;
    }).join('') || '<p class="muted">No spells known. Add them in the Character Creator.</p>';
    sc.innerHTML = `
        <div class="row-item"><span>Spell slots</span><b>${slotLine || '—'}${pactLine ? '  ·  ' + pactLine : ''}</b></div>
        <h4>Spellcasting</h4>${casterSummary}
        <h4>Known / Prepared</h4>${spellSections}`;
}

function renderActionsPanel(char, d) {
    const ac = document.getElementById('actions-content');

    // Combat, my turn: the panel becomes the action bar for the ACTIVE
    // combatant (its server-held attacks, not the HUD character's — a player
    // with several tokens acts with whichever one has the turn).
    const active = combatState && combatState.started && combatState.combatants[combatState.activeId];
    if (active && active.owner === myUsername && !combatantDown(active)) {
        const c = active;
        const dis = c.actionUsed ? 'disabled' : '';
        const atkBtns = (c.attacks || []).map((a, i) =>
            `<button class="btn-combat atk" data-combat-atk="${i}" ${dis}>⚔ ${escHtml(a.name)} <span class="tag">${fmtMod(a.attack)} · ${escHtml(a.damage)} ${escHtml(a.damageType)}</span></button>`
        ).join('') || '<p class="muted">No attacks.</p>';
        ac.innerHTML = `
            <div class="row-item"><span>▶ ${escHtml(c.name)}'s turn — Round ${combatState.round}</span><b>${remainingFeet(c)} ft left</b></div>
            ${c.actionUsed ? '<p class="muted">Action used this turn — you can still move, then end your turn.</p>' : ''}
            <h4>Attacks</h4>
            <div class="combat-actions-list">${atkBtns}</div>
            <h4>Other Actions</h4>
            <div class="combat-actions-list">
                <button class="btn-combat" data-combat-act="dash" ${dis}>💨 Dash <span class="tag">+${c.speedFeet} ft move</span></button>
                <button class="btn-combat" data-combat-act="dodge" ${dis}>🛡 Dodge <span class="tag">attacks vs you at disadv.</span></button>
                <button class="btn-combat" data-combat-act="disengage" ${dis}>↪ Disengage</button>
                <button class="btn-combat end" data-combat-act="end-turn">■ End Turn</button>
            </div>`;
        ac.querySelectorAll('[data-combat-atk]').forEach(btn => btn.onclick = () => {
            const i = +btn.dataset.combatAtk;
            if (c.attacks[i]) beginTargetPick(c.id, i, c.attacks[i]);
        });
        ac.querySelectorAll('[data-combat-act]').forEach(btn => btn.onclick = () => {
            const act = btn.dataset.combatAct;
            if (!socket) return;
            if (act === 'end-turn') socket.emit('combat-end-turn', {});
            else socket.emit('combat-action', { combatantId: c.id, kind: act });
        });
        return;
    }

    // Outside combat (or waiting for the turn): the reference list.
    const waiting = combatState && combatState.started
        ? `<p class="muted">⚔ Combat — waiting for ${escHtml(active ? active.name : '…')}'s turn.</p>` : '';
    const eq = char.equipment || {};
    const attacks = (eq.weapons || []).map(wi => {
        const w = SRD.get('equipment', wi); if (!w) return '';
        const a = SRD.weaponAttack(w, d.mods, char.classes || [], d.prof);
        return `<div class="row-item"><span>${escHtml(w.name)} <span class="tag">${a.ranged ? 'ranged ' + a.range : 'melee'}</span></span><b>${fmtMod(a.attack)} to hit · ${a.damage} ${escHtml(a.damageType)}</b></div>`;
    }).join('') || '<p class="muted">No weapon attacks.</p>';
    const standard = ['Attack', 'Cast a Spell', 'Dash', 'Disengage', 'Dodge', 'Help', 'Hide', 'Ready', 'Search', 'Use an Object']
        .map(x => `<div class="row-item"><span>${x}</span></div>`).join('');
    ac.innerHTML = `${waiting}
        <h4>Attacks</h4>${attacks}
        <h4>Standard Actions</h4>${standard}
        <div class="muted" style="margin-top:8px;">Bonus actions &amp; reactions depend on your class features and prepared spells.</div>`;
}

// --- UI Management (Left Menu) ---
function setTool(toolName) {
    if (currentTool === 'ruler' && toolName !== 'ruler') {
        ruler.clearAll(() => { if (socket) socket.emit('clear-rulers'); });
    }
    if (toolName !== 'ruler') {
        ruler.hideTooltip();
    }
    currentTool = toolName;
    for (const key in toolMenuButtons) {
        toolMenuButtons[key].classList.toggle('active', key === toolName);
    }
}

// --- Move Tool ---
function setMoveMode(mode) {
    currentMoveMode = mode;
    setTool('move');
    for (const key in moveSubMenuButtons) {
        moveSubMenuButtons[key].classList.toggle('active',
            key === mode || (key === 'standard' && mode === 'standard'));
    }
    moveSubMenu.style.display = 'none';
}

// --- Ruler Tool ---
function setRulerMode(mode) {
    ruler.setMode(mode);
    setTool('ruler');
    rulerSubMenuButtons.straight.classList.toggle('active', mode === 'straight');
    rulerSubMenuButtons.curved.classList.toggle('active', mode === 'curved');
}
function setRulerSnapMode(mode) {
    ruler.setSnapMode(mode);
    rulerSnapSubMenuButtons.center.classList.toggle('active', mode === 'center');
    rulerSnapSubMenuButtons.corner.classList.toggle('active', mode === 'corner');
}
function setRulerColor(colorValue, clickedButton) {
    ruler.setColor(colorValue);
    document.querySelectorAll('#ruler-colors .color-swatch').forEach(swatch => {
        swatch.classList.remove('active');
    });
    clickedButton.classList.add('active');
}

// --- Socket.IO: receive and share the GM's map in real time ---
function initSocket(username) {
    socket = io();
    myUsername = username;
    combatTracker = new CombatTracker({
        container: document.getElementById('combat-tracker'),
        socket, isGM: false, username,
        onPickTarget: beginTargetPick
    });

    socket.on('connect', () => {
        console.log('Conectado ao servidor com ID:', socket.id);
        socket.emit('login', username);
        sessionStorage.setItem('vtt_username', username);
        // Reconnects auto-join 'world' server-side; come back to where we were.
        if (currentMapKey !== 'world') socket.emit('join-map', { key: currentMapKey });
    });

    socket.on('login-success', (userData) => {
        console.log('Jogador autenticado:', userData);
        login.hide();
    });

    // --- Character data for the HUD ---
    socket.on('load-user-characters', (chars) => {
        myCharacters = Array.isArray(chars) ? chars : [];
        if (!myCharacters.find(c => c.id === activeCharId)) {
            activeCharId = myCharacters[0] ? myCharacters[0].id : null;
        }
        renderHUD();
        answerStatsPending(); // combat may have arrived before the characters
    });

    socket.on('load-homebrew', (hb) => {
        pendingHomebrew = hb;
        if (SRD) { SRD.setHomebrew(hb); renderHUD(); }
    });

    socket.on('character-updated', (char) => {
        if (!char || !char.id) return;
        const i = myCharacters.findIndex(c => c.id === char.id);
        if (i >= 0) myCharacters[i] = char;
        else if (char.owner === username || (username && username.toLowerCase() === 'gm')) myCharacters.push(char);
        renderHUD();
    });

    socket.on('character-deleted', (charId) => {
        myCharacters = myCharacters.filter(c => c.id !== charId);
        if (activeCharId === charId) activeCharId = myCharacters[0] ? myCharacters[0].id : null;
        renderHUD();
    });

    // --- Combat sync ---
    socket.on('combat-updated', (combat) => setCombat(combat));
    socket.on('combat-log', (entry) => { if (combatTracker) combatTracker.appendLog(entry); });
    socket.on('combat-denied', ({ reason }) => { if (combatTracker) combatTracker.flash(reason || 'Not allowed'); });

    // Live HP sync: another client (or this one elsewhere) changed current HP.
    socket.on('hp-updated', ({ id, current }) => {
        hpState[id] = current;
        const c = myCharacters.find(x => x.id === id);
        if (c) { if (c.hp) c.hp.current = current; else c.hp = { current }; }
        const a = activeChar();
        if (a && a.id === id) renderHUD();
    });

    // Full map state on connect
    socket.on('map-state', (data) => {
        // Ignore states for maps we're not on (e.g. the automatic 'world' join
        // that precedes our re-join after a reconnect).
        if (data.key && data.key !== currentMapKey) return;
        objects.forEach(obj => worldGroup.remove(obj));
        objects = [];
        ruler.removeSegments();

        data.objects.forEach(objData => createObjectFromData(objData.id, objData));
        data.rulers.forEach(rulerData => ruler.addFromData(rulerData.id, rulerData));
        setCombat(data.combat || null); // joiners land mid-combat fully synced

        // Pocket-map boundary rectangle (dungeons/rooms).
        if (boundsRect) { scene.remove(boundsRect); boundsRect.geometry.dispose(); boundsRect = null; }
        if (data.meta && data.meta.kind === 'pocket') {
            boundsRect = buildBoundsRect(data.meta.width, data.meta.height);
            scene.add(boundsRect);
        }

        // Terrain.
        if (terrain) {
            // GM-painted hex biomes override generation — players generate the
            // same world locally, so they need the same tag tree.
            if (data.hexTree) { hexTree = data.hexTree; terrain.setBiomeOverrides(hexTree); }
            if (data.unified) {
                // One continuous world: load once, then fly between provinces.
                if (!terrainIsUnified) {
                    terrain.generatorOn = true;
                    terrain.reset();
                    if (data.terrain) terrain.applyData(data.terrain);
                    terrainIsUnified = true;
                }
                terrain.group.visible = true;
                styleGroundForTerrain(plane, true);
                // The unified world renders at every altitude (LOD rings + ocean):
                // players can zoom out to survey, not just hug the ground.
                controls.maxDistance = 811008;
                if (data.worldCenter) {
                    const c = data.worldCenter;
                    // Land with the floating origin already under the province, so
                    // scene coords start near zero however far out the world we are.
                    const o = setWorldOriginAt({ terrain, worldGroup }, c.x, c.z);
                    controls.target.set(c.x - o.x, 0, c.z - o.z);
                    camera.position.set(c.x - o.x + 20, 30, c.z - o.z + 20);
                }
            } else {
                // Pockets live near the true origin: pin the floating origin to 0.
                // Generator OFF: pocket ground is implicit flat 0 plus edits.
                setWorldOriginAt({ terrain, worldGroup }, 0, 0);
                terrainIsUnified = false;
                terrain.generatorOn = false;
                controls.maxDistance = 6000;   // finite room: no surveying the void
                terrain.reset();
                const hasTerrain = !!data.terrain;
                if (hasTerrain) terrain.applyData(data.terrain);
                terrain.group.visible = hasTerrain;
                styleGroundForTerrain(plane, hasTerrain);
            }
        }
    });

    // Live terrain edits from the GM (partial chunk payload).
    socket.on('terrain-updated', (data) => {
        if (terrain) { terrain.applyData(data); terrain.group.visible = true; styleGroundForTerrain(plane, true); }
    });

    // GM painted/cleared a biome hex: the world regenerates under it.
    // (Debounced — rapid paint strokes coalesce into one heavy rebuild.)
    socket.on('hex-updated', ({ key, hex, biome }) => {
        if (!key || !terrain) return;
        const layer = { ...(hexTree[key] || {}) };
        if (biome) layer[hex] = { biome };
        else delete layer[hex];
        hexTree = { ...hexTree, [key]: layer };
        terrain.setBiomeOverrides(hexTree);
        clearTimeout(regenTimer);
        regenTimer = setTimeout(() => terrain.regenerate(), 400);
    });

    socket.on('object-added', (data) => {
        if (!objects.find(o => o.userData.syncId === data.id)) {
            createObjectFromData(data.id, data);
        }
    });

    socket.on('object-moved', (data) => {
        const object = objects.find(o => o.userData.syncId === data.id);
        if (object) {
            object.position.set(data.position.x, data.position.y, data.position.z);
        }
    });

    socket.on('object-deleted', (data) => {
        const object = objects.find(o => o.userData.syncId === data.id);
        if (object) {
            if (selectedObject === object) deselectObject();
            worldGroup.remove(object);
            objects = objects.filter(o => o.userData.syncId !== data.id);
        }
    });

    socket.on('ruler-added', (data) => {
        if (!ruler.hasSegment(data.id)) {
            ruler.addFromData(data.id, data);
        }
    });

    socket.on('rulers-cleared', () => {
        ruler.removeSegments();
    });

    socket.on('error', (message) => {
        console.error('Erro do servidor:', message);
        login.showError(message);
        login.reset();
    });

    socket.on('disconnect', () => {
        console.log('Desconectado do servidor.');
    });
}

// --- Init ---
try {
    init();
} catch (e) {
    console.error('Fatal Error on Init:', e);
}

const login = setupLoginModal(initSocket);

// Load SRD data for the character-sheet HUD (independent of the 3D scene).
loadSRD().then(srd => {
    SRD = srd;
    if (pendingHomebrew) SRD.setHomebrew(pendingHomebrew);
    renderHUD();
    answerStatsPending(); // combat may have arrived before the SRD finished loading
}).catch(e => console.error('Failed to load SRD data:', e));
