// player.js — player screen (/player): shared-map view (GM-authored terrain is
// view-only), token moving, rulers, and the character-sheet HUD (Character /
// Inventory / Spells / Actions panels). Scene boilerplate, meshes and the ruler
// tool live in ../shared/.

import * as THREE from 'three';
import { loadSRD, ABILITIES, abilityMod, fmtMod, proficiencyBonus } from '../shared/srd.js';
import { Terrain } from '../shared/terrain.js';
import { Grass } from '../shared/grass.js';
import { Trees } from '../shared/trees.js';
import { createTabletopScene, startRenderLoop, castFromPointer, snapToGrid, trackRightDrag, styleGroundForTerrain, buildBoundsRect, updateWorldFollow, setWorldOriginAt, maybeRebaseWorld, CameraFly, FOG_NEAR, FOG_FAR, GRID_CELL_SIZE, FEET_PER_GRID_CELL } from '../shared/scene.js';
import { buildObjectFromData, applyMove } from '../shared/models.js';
import { tickRigCharacters } from '../shared/charmesh.js';
import { RulerTool } from '../shared/rulers.js';
import { bindLongPress, dismissSubmenusOnOutsideClick } from '../shared/ui.js';
import { setupLoginModal } from '../shared/login.js';
import { CombatTracker, CombatOverlays, combatAttackDamageLabel, deriveCombatStats, remainingFeet, EFFECTS } from '../shared/combat.js';
import { combatInteger, combatModifier, combatSpellLevel } from '../shared/combat-safety.js';
import { FogMask, FogOverlay, chunkFogHexKey } from '../shared/fog.js';
import { createTabletopWorkspace } from '../shared/workspace.js';
import { ObjectNameplates, objectIdentity, setObjectSelected, updateObjectPresentation, updateObjectPositionData } from '../shared/object-ui.js';
import { disposeBuiltObject, structureLevel, structureStoreyLevel, structureTouchesLevel, isStructureType } from '../shared/structures.js';
import { AuthenticatedMapReload } from '../shared/sync-state.js';

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
let workspace = null;
let objectNameplates = null;
let selectionReturnContext = null;
let selectionOwnsInspector = false;

// --- Combat mode (server-authoritative, synced via combat-updated) ---
let combatState = null;
let combatTracker = null;
let pendingAttack = null;       // { combatantId, attackIndex } while picking a target
let pendingSpell = null;        // { combatantId, spellIndex } while picking a target
let dragStartPos = null;        // selected token's world position when the move began
let combatOverlays = null;      // turn/range rings + effect badges (created in init)
let closeAllPanels = () => {};  // assigned in init (needs the HUD overlay refs)
let showCharacterPanel = () => {}; // assigned in init; shared by cards + tabs

let currentTool = null;
let currentMoveMode = 'standard';
let toolMenuButtons = {};
let moveSubMenuButtons = {};
let moveSubMenu;
let isDraggingHeight = false;

let placeCharacter = null; // character being placed (place tool armed via the right menu)
let characterInstances = []; // my placed tokens across all maps (Instances tab), server-pushed
let pendingFocus = null;     // world position to jump to once the next map-state lands
let pendingViewPose = null;  // GM-directed camera pose to apply after a relocate join

let rulerSubMenu, rulerSubMenuButtons = {};
let rulerSnapSubMenuButtons = {};
let wasRightDrag = null; // right-drag orbits the camera; see trackRightDrag
let boundsRect = null;   // pocket-map boundary rectangle
let currentMapKey = 'world'; // players travel between maps via portals
let terrainIsUnified = false; // is the loaded terrain the shared continuous world?
const mapReload = new AuthenticatedMapReload();
let hexTree = {};            // GM biome tags (generator overrides), synced via map-state
let regenTimer = null;       // debounce for biome-driven regeneration
// Fog of war (U4): the server only sends content inside GM-revealed regions;
// the mask mirrors the server and the overlay darkens everything outside it.
const fogMask = new FogMask();
let fogOverlay = null;       // created in init
// GM-directed camera (View control): the GM can fly/snap this view to a pose
// and optionally lock the controls until released.
let cameraFly = null;        // created in init

// Local multi-storey cutaway. It never changes shared map state: each player
// may inspect the floor relevant to their token without changing anyone else.
const levelView = { active: 0, isolate: false };
let levelCutawayState = null;

const emitRuler = (data) => { if (socket) socket.emit('add-ruler', data); };

function init() {
    workspace = createTabletopWorkspace({
        panels: {
            'character-menu': { title: 'Characters', kicker: 'Your roster' },
            'selection-panel': { title: 'Selection', kicker: 'Map object' },
            'hud-panel-overlay': { title: 'Character', kicker: 'Character' }
        },
        defaultPanel: 'character-menu',
        dockVisible: false,
        onInspectorClose: () => {
            if (selectionOwnsInspector && ['selection-panel', 'hud-panel-overlay'].includes(workspace?.currentPanel())) {
                selectionReturnContext = null;
                selectionOwnsInspector = false;
            }
            if (workspace) workspace.setMode({ move: 'Move', ruler: 'Measure', place: 'Place' }[currentTool] || 'Explore');
        },
        shortcuts: [
            { key: 'M', label: 'Move your selected character' },
            { key: 'R', label: 'Measure distance' },
            { key: 'C', label: 'Open your character library' },
            { key: 'A', label: 'Open character actions' },
            { key: 'E', label: 'Show or hide the encounter dock' },
            { key: '.', label: 'Focus the selected token' },
            { key: 'Esc', label: 'Cancel placement, targeting or selection' },
            { key: '?', label: 'Show this shortcut reference' }
        ]
    });

    ({ scene, camera, renderer, controls, plane, grid, raycaster, mouse, dirLight, worldGroup } =
        createTabletopScene(document.getElementById('scene-container')));
    objectNameplates = new ObjectNameplates();

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

    // Fog sheet over unrevealed regions (world coords; hidden until a unified
    // map-state arrives — pockets are never fogged).
    fogOverlay = new FogOverlay(worldGroup, { opacity: 0.94 });
    fogOverlay.setVisible(false);

    cameraFly = new CameraFly(camera, controls);
    // The player's own camera input wins over an UNLOCKED GM flight (otherwise
    // wheel/orbit compose with the fly and fight it). Locked views disable
    // controls, so these can't break a lock.
    renderer.domElement.addEventListener('wheel', () => { if (controls.enabled) cameraFly.cancel(); }, { passive: true });
    renderer.domElement.addEventListener('pointerdown', (e) => { if (e.button !== 0 && controls.enabled) cameraFly.cancel(); });

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

    document.getElementById('level-view-down').addEventListener('click', () => stepPlayerLevel(-1));
    document.getElementById('level-view-up').addEventListener('click', () => stepPlayerLevel(1));
    document.getElementById('level-view-toggle').addEventListener('click', () => {
        levelView.isolate = !levelView.isolate;
        if (levelView.isolate && !availableStructureLevels().includes(levelView.active)) levelView.active = 0;
        applyPlayerLevelVisibility();
    });

    dismissSubmenusOnOutsideClick([
        [moveSubMenu, toolMenuButtons.move],
        [rulerSubMenu, toolMenuButtons.ruler]
    ]);

    // --- Character menu tabs (right): Spawn | Instances ---
    document.getElementById('char-tab-spawn').addEventListener('click', () => setCharacterTab('spawn'));
    document.getElementById('char-tab-instances').addEventListener('click', () => setCharacterTab('instances'));

    // --- HUD panel logic ---
    const hudOverlay = document.getElementById('hud-panel-overlay');
    const hudButtons = document.querySelectorAll('#player-hud .hud-button');
    const closeButtons = document.querySelectorAll('.close-panel-btn');

    showCharacterPanel = (panelId) => {
        // Character work supersedes an armed placement gesture. Other map
        // tools remain selected underneath and resume when the inspector closes.
        if (currentTool === 'place') {
            placeCharacter = null;
            currentTool = null;
            for (const key in toolMenuButtons) toolMenuButtons[key].classList.remove('active');
            syncCharacterMenuActive();
        }
        if (workspace) workspace.setMode(panelId === 'character-menu' ? 'Characters' : 'Character');
        renderHUD(); // refresh sheet from latest character data
        document.querySelectorAll('.hud-panel').forEach(p => p.classList.add('hidden'));
        hudButtons.forEach(button => button.classList.toggle('active', button.dataset.panel === panelId));

        if (panelId === 'character-menu') {
            hudOverlay.style.display = 'none';
            if (workspace) workspace.showPanel('character-menu', 'Characters');
            return;
        }

        const panel = document.getElementById(panelId);
        if (!panel) return;
        hudOverlay.style.display = 'flex';
        if (workspace) workspace.showPanel('hud-panel-overlay', panel.querySelector('h3')?.textContent || 'Character');
        panel.classList.remove('hidden');
    };

    hudButtons.forEach(button => button.addEventListener('click', () => showCharacterPanel(button.dataset.panel)));
    const topCharacters = document.getElementById('btn-workspace-characters');
    if (topCharacters) topCharacters.addEventListener('click', () => showCharacterPanel('character-menu'));

    closeAllPanels = function () {
        if (workspace) workspace.closeInspector();
    };

    document.getElementById('btn-end-turn').addEventListener('click', () => {
        if (socket) socket.emit('combat-end-turn', {});
    });

    closeButtons.forEach(btn => btn.addEventListener('click', closeAllPanels));
    updatePlayerHintBar();

    // Headless-testing handle (mirrors gm.js __dbg; socket attaches on login).
    window.__dbg = { terrain, scene, camera, controls, worldGroup, fogMask, cameraFly };

    startRenderLoop({
        renderer, scene, camera, controls,
        onTick: () => {
            if (cameraFly && terrain) cameraFly.tick(terrain.worldOrigin); // GM-directed flight owns the camera this frame
            updateWorldFollow({ plane, grid, dirLight, camera }, controls.target); // ground/shadows follow
            if (combatOverlays) combatOverlays.tick(); // rings/badges track their tokens
            tickRigCharacters();                                           // character idle/walk clips
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
    const vegetationVisible = terrainIsUnified && !levelCutawayState;
    if (grass) grass.update(camera, controls, vegetationVisible);
    if (trees) trees.update(camera, controls, vegetationVisible);
    if (fogOverlay) fogOverlay.update(fogMask, worldTarget.x, worldTarget.z, dist);
}

function onPointerDown(event) {
    // Left button = tools; right/middle = camera (OrbitControls).
    if (event.button !== 0) return;

    if (isDraggingHeight) {
        isDraggingHeight = false;
        if (selectedObject && playerOwnsObject(selectedObject) && selectedObject.userData.syncId && socket) {
            const position = { x: selectedObject.position.x, y: selectedObject.position.y, z: selectedObject.position.z };
            updateObjectPositionData(selectedObject);
            socket.emit('move-object', { id: selectedObject.userData.syncId, position });
        }
        deselectObject();
        return;
    }

    castFromPointer(event, { renderer, camera, raycaster, mouse });
    const allObjects = [...(levelCutawayState ? [] : [plane]), ...objects.filter(o => o.visible)];
    const intersects = raycaster.intersectObjects(allObjects, true);
    if (intersects.length === 0) return;

    const firstIntersect = intersects[0];
    let topLevelObject = firstIntersect.object;
    while (topLevelObject.parent && topLevelObject.parent !== scene && topLevelObject.parent !== worldGroup) {
        topLevelObject = topLevelObject.parent;
    }
    const clickedObject = objects.find(obj => obj === topLevelObject);

    // GM-built structures are scenery to players. A floor, tread or visible
    // roof hit becomes the support height for placement and movement.
    const clickedType = clickedObject && clickedObject.userData.objectType;
    const buildAsGround = isStructureType(clickedType);

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
        updatePlayerHintBar();
        return;
    }
    if (pendingSpell) {
        const targetId = clickedObject && clickedObject.userData.syncId;
        if (targetId && combatState && combatState.combatants[targetId] && socket) {
            socket.emit('combat-action', {
                combatantId: pendingSpell.combatantId, kind: 'cast',
                spellIndex: pendingSpell.spellIndex, targetId
            });
        } else if (combatTracker) {
            combatTracker.flash('Spell cancelled — that was not a combatant');
        }
        pendingSpell = null;
        updatePlayerHintBar();
        return;
    }

    if (clickedObject && !buildAsGround) {
        // Combat: combatant tokens are locked to their owner, on their turn.
        const deny = currentTool === 'move' ? combatSelectDenied(clickedObject) : null;
        if (deny) {
            selectObject(clickedObject, { openInspector: true });
            if (combatTracker) combatTracker.flash(deny);
            return;
        }
        if (currentTool === 'move' && !playerOwnsObject(clickedObject)) {
            selectObject(clickedObject, { openInspector: true });
            return;
        }
        if (currentTool === 'move' && currentMoveMode === 'y-only') {
            selectObject(clickedObject, { openInspector: false });
            isDraggingHeight = true;
        } else {
            if (selectedObject === clickedObject) {
                deselectObject();
            } else {
                selectObject(clickedObject, { openInspector: currentTool !== 'move' });
            }
        }
    } else if (firstIntersect.object.name === "tabletop" || buildAsGround) {
        const support = (buildAsGround || ['move', 'place', 'ruler'].includes(currentTool))
            ? pickPlayerSupportSurface(event, { exclude: selectedObject }) : null;
        const intersectPoint = support ? support.point : sceneToWorld(firstIntersect.point);

        switch (currentTool) {
            case 'move':
                if (selectedObject && playerOwnsObject(selectedObject)) {
                    // Emit the move to the server (shared map)
                    const docId = selectedObject.userData.syncId;
                    if (docId && socket) {
                        if (support) selectedObject.position.y = support.point.y + (selectedObject.userData.halfHeight || 0);
                        const finalPosition = snapToGrid(selectedObject.position);
                        selectedObject.position.x = finalPosition.x;
                        selectedObject.position.z = finalPosition.z;
                        updateObjectPositionData(selectedObject);
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
                } else if (selectedObject) {
                    deselectObject();
                }
                break;
            case 'ruler':
                ruler.click(ruler.snap(intersectPoint), emitRuler);
                break;
            case 'place':
                placeCharacterAt(intersectPoint, support && support.object ? support.point.y : null);
                break;
            default:
                if (selectedObject) deselectObject();
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

    if (currentTool === 'place' && placeCharacter) {
        // Reuse the ruler tooltip as the placement hint (the tools are exclusive).
        const el = document.getElementById('ruler-tooltip');
        if (el) {
            el.textContent = `Place ${placeCharacter.name || 'character'} — click the ground (Esc cancels)`;
            el.style.display = 'block';
            el.style.left = (event.clientX + 14) + 'px';
            el.style.top = (event.clientY + 14) + 'px';
        }
        return;
    }

    if (currentTool !== 'move' && currentTool !== 'ruler') return;
    const support = pickPlayerSupportSurface(event, { exclude: selectedObject });
    if (!support) return;
    const intersectPoint = support.point;

    if (currentTool === 'move' && selectedObject && playerOwnsObject(selectedObject)) {
        // Standard movement follows the clicked terrain/floor/stair/roof surface.
        applyMove(selectedObject, snapToGrid(intersectPoint), currentMoveMode,
            (x, z, halfHeight) => intersectPoint.y + halfHeight);
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
    const support = pickPlayerSupportSurface(event);
    if (support) ruler.restartAt(ruler.snap(support.point), emitRuler);
}

function onKeyDown(event) {
    const tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return;

    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat) {
        const key = event.key.toLowerCase();
        if (key === 'm') { event.preventDefault(); setMoveMode('standard'); return; }
        if (key === 'r') { event.preventDefault(); setRulerMode(ruler.mode); return; }
        if (key === 'c') { event.preventDefault(); showCharacterPanel('character-menu'); return; }
        if (key === 'a') { event.preventDefault(); showCharacterPanel('actions-panel'); return; }
        if (key === 'e') { event.preventDefault(); workspace?.toggleDock(); return; }
        if (event.key === '.' && selectedObject) { event.preventDefault(); jumpCameraTo(selectedObject.position); return; }
    }

    // No delete for players
    if (event.key === "Escape") {
        if (pendingAttack) {
            pendingAttack = null;
            if (combatTracker) combatTracker.flash('Attack cancelled');
            updatePlayerHintBar();
            return;
        } else if (pendingSpell) {
            pendingSpell = null;
            if (combatTracker) combatTracker.flash('Spell cancelled');
            updatePlayerHintBar();
            return;
        }
        if (currentTool === 'place') {
            setTool('move'); // also drops placeCharacter (see setTool)
        } else if (currentTool === 'ruler' && ruler.points.length > 0) {
            ruler.clearInProgress();
        } else if (isDraggingHeight) {
            isDraggingHeight = false;
            deselectObject();
        } else if (selectedObject) {
            deselectObject();
        }
    }
}

function updatePlayerHintBar() {
    const bar = document.getElementById('hint-bar');
    if (!bar) return;
    const cam = 'RMB orbit · MMB pan · wheel zoom';
    if (pendingAttack || pendingSpell) {
        bar.textContent = `Pick a combat target · click a token · Esc cancel · ${cam}`;
    } else if (currentTool === 'place' && placeCharacter) {
        bar.textContent = `Place ${placeCharacter.name || 'character'} · click the ground · Esc cancel · ${cam}`;
    } else if (currentTool === 'move') {
        bar.textContent = selectedObject && playerOwnsObject(selectedObject)
            ? `Move ${objectIdentity(selectedObject, objects).displayName} · click the ground to drop · ${cam}`
            : `Move · click one of your character tokens · ${cam}`;
    } else if (currentTool === 'ruler') {
        bar.textContent = `Measure · click to add points · right-click restart · Esc cancel · ${cam}`;
    } else if (selectedObject) {
        bar.textContent = `${objectIdentity(selectedObject, objects).displayName} selected · . focus · Esc clear · ${cam}`;
    } else {
        bar.textContent = `Click a token to inspect · C characters · M move · R measure · ${cam}`;
    }
}

// Scene <-> world conversion at the raycast/camera boundary (floating origin).
function sceneToWorld(p) {
    return new THREE.Vector3(p.x + terrain.worldOrigin.x, p.y, p.z + terrain.worldOrigin.z);
}

function pickPlayerSupportSurface(event, { exclude = null } = {}) {
    castFromPointer(event, { renderer, camera, raycaster, mouse });
    const structures = objects.filter(o => o !== exclude && o.visible &&
        ['floor', 'stair', 'roof'].includes(o.userData.objectType));
    const targets = [...structures];
    if (!levelCutawayState) {
        if (terrain && terrain.group.visible) targets.push(terrain.chunkGroup);
        targets.push(plane);
    }
    const hit = raycaster.intersectObjects(targets, true)[0];
    if (!hit) return null;
    let top = hit.object;
    while (top.parent && top.parent !== scene && top.parent !== worldGroup && top.parent !== terrain?.chunkGroup) top = top.parent;
    return { point: sceneToWorld(hit.point), object: objects.find(o => o === top) || null };
}

function availableStructureLevels() {
    const levels = new Set([0]);
    for (const object of objects) {
        const data = object.userData.objectData || {};
        if (!isStructureType(object.userData.objectType)) continue;
        const here = structureStoreyLevel(data);
        levels.add(here);
        if (data.type === 'stair') {
            const there = Number.isFinite(Number(data.toLevel))
                ? Math.round(Number(data.toLevel))
                : here + Math.sign(Number(data.rise) || 1);
            levels.add(there);
        }
    }
    return [...levels].sort((a, b) => a - b);
}

function playerLevelName(level) {
    return level < 0 ? `B${Math.abs(level)}` : level > 0 ? `L${level}` : 'Ground';
}

function stepPlayerLevel(direction) {
    const levels = availableStructureLevels();
    if (!levelView.isolate) {
        const candidates = direction < 0 ? levels.filter(n => n < 0).reverse() : levels.filter(n => n > 0);
        levelView.active = candidates[0] ?? 0;
        levelView.isolate = true;
    } else {
        const next = direction < 0
            ? [...levels].reverse().find(n => n < levelView.active)
            : levels.find(n => n > levelView.active);
        if (next != null) levelView.active = next;
    }
    applyPlayerLevelVisibility();
}

function restorePlayerCutaway() {
    if (!levelCutawayState) return;
    if (terrain) terrain.group.visible = levelCutawayState.terrain;
    if (plane) plane.visible = levelCutawayState.plane;
    levelCutawayState = null;
}

function applyPlayerLevelVisibility() {
    const levels = availableStructureLevels();
    const vertical = levels.some(n => n !== 0);
    if (!vertical) levelView.isolate = false;
    for (const object of objects) {
        const type = object.userData.objectType;
        if (!isStructureType(type)) continue;
        const data = object.userData.objectData || { type };
        object.visible = !levelView.isolate || structureTouchesLevel(data, levelView.active);
    }
    const cutAwayTerrain = vertical && levelView.isolate && levelView.active < 0;
    if (cutAwayTerrain && terrain && plane) {
        if (!levelCutawayState) levelCutawayState = { terrain: terrain.group.visible, plane: plane.visible };
        terrain.group.visible = false;
        plane.visible = false;
        if (grass) grass.hide();
        if (trees) trees.hide();
    } else if (!cutAwayTerrain) {
        restorePlayerCutaway();
    }

    const panel = document.getElementById('level-view');
    if (panel) panel.classList.toggle('hidden', !vertical);
    const toggle = document.getElementById('level-view-toggle');
    if (toggle) toggle.textContent = levelView.isolate ? playerLevelName(levelView.active) : 'All levels';
    const down = document.getElementById('level-view-down');
    const up = document.getElementById('level-view-up');
    const pivot = levelView.isolate ? levelView.active : 0;
    if (down) down.disabled = !levels.some(n => n < pivot);
    if (up) up.disabled = !levels.some(n => n > pivot);
}

function focusCameraOn(worldPos) {
    controls.target.set(worldPos.x - terrain.worldOrigin.x, worldPos.y, worldPos.z - terrain.worldOrigin.z);
}

// GM view lock: while locked the GM owns this camera — orbit/pan/zoom are
// disabled (tools still work) and a banner says so.
function setViewLock(locked) {
    controls.enabled = !locked;
    const banner = document.getElementById('view-lock-banner');
    if (banner) banner.classList.toggle('hidden', !locked);
}

// --- Character menu (right): place your own character on the map ---
// Click a character button: select it for the HUD and arm placement for a new
// token instance (click again to cancel). Spawn selection is deliberately
// camera-neutral; the Instances tab is the explicit "jump to token" control.
function armPlaceCharacter(char) {
    if (!char) return;
    activeCharId = char.id;
    renderHUD();
    // Selecting a character means the player is taking control — stop any
    // in-progress GM-directed flight (unlocked only, mirroring the wheel/pointer
    // handlers) so it can't keep dragging the camera back to the GM's view.
    if (controls.enabled) {
        if (cameraFly) cameraFly.cancel();
        pendingViewPose = null;
    }
    if (currentTool === 'place' && placeCharacter && placeCharacter.id === char.id) {
        setTool('move'); // toggle off (also drops placeCharacter, see setTool)
        return;
    }
    placeCharacter = char;
    setTool('place');
    syncCharacterMenuActive();
    if (workspace) workspace.closeInspector();
}

// Mirrors the GM's loadCharactersToMenu: one button per character, colored.
function renderCharacterMenu() {
    const listContainer = document.getElementById('character-button-list');
    if (!listContainer) return;
    listContainer.innerHTML = '';

    if (!myCharacters.length) {
        listContainer.innerHTML = '<div class="workspace-empty">You do not have a character yet.<br><button class="workspace-primary" data-workspace-studio="/">Create your first character</button></div>';
        return;
    }

    myCharacters.forEach(char => {
        const card = document.createElement('div');
        card.className = 'character-card';
        card.style.setProperty('--character-color', char.color || '#7f8a99');

        const main = document.createElement('button');
        main.className = 'character-card-main';
        const classes = (char.classes || []).map(c => `${c.class || 'class'} ${c.level || 1}`).join(' / ');
        main.innerHTML = '<span class="character-card-name"></span><span class="character-card-meta"></span>';
        main.querySelector('.character-card-name').textContent = char.name || 'Unnamed';
        main.querySelector('.character-card-meta').textContent = classes || char.race || 'Character';
        main.title = 'Open character sheet';
        main.addEventListener('click', () => {
            activeCharId = char.id;
            renderHUD();
            showCharacterPanel('char-panel');
        });

        const place = document.createElement('button');
        place.className = 'character-card-place';
        place.textContent = 'Place';
        place.title = 'Place another token instance';
        place.dataset.charId = char.id;
        place.addEventListener('click', () => armPlaceCharacter(char));

        card.append(main, place);
        listContainer.appendChild(card);
    });
    syncCharacterMenuActive();
}

function syncCharacterMenuActive() {
    document.querySelectorAll('#character-button-list .character-card-place').forEach(btn => {
        btn.classList.toggle('active', !!placeCharacter && btn.dataset.charId === placeCharacter.id);
    });
}

// --- Character menu tabs: Spawn (place tokens) | Instances (where they are) ---
function setCharacterTab(tab) {
    document.getElementById('char-tab-spawn').classList.toggle('active', tab === 'spawn');
    document.getElementById('char-tab-instances').classList.toggle('active', tab === 'instances');
    document.getElementById('character-button-list').classList.toggle('hidden', tab !== 'spawn');
    document.getElementById('character-instance-list').classList.toggle('hidden', tab !== 'instances');
    if (tab === 'instances' && socket) socket.emit('get-character-instances'); // fresh on open
}

// Tactical paths share the '@world' room server-side; mirror that routing so
// "already on this map" checks match the room the server actually joined us to.
function roomKeyOf(key) {
    return /^world(\/-?\d+,-?\d+){3}$/.test(key) ? '@world' : key;
}

// Snap the orbit target to a world position and re-seat the camera beside it
// (same fresh viewpoint as portal travel). On the unified world we re-seat the
// floating origin at the destination first, so we land there exactly however
// far the origin sat before (e.g. left at the GM's look point by a "Bring to my
// view") — not relying on maybeRebaseWorld to inch there over later frames.
function jumpCameraTo(worldPos) {
    if (cameraFly) cameraFly.cancel();
    if (terrainIsUnified) setWorldOriginAt({ terrain, worldGroup }, worldPos.x, worldPos.z);
    focusCameraOn(worldPos);
    camera.position.set(controls.target.x + 8, controls.target.y + 12, controls.target.z + 8);
}

// Click an instance row: fly to the token if its map is already loaded,
// otherwise travel there (join its map, then jump once map-state lands).
function gotoInstance(inst) {
    // A locked GM view stays authoritative. Spawn selection remains available
    // for the HUD, but explicit camera travel waits until the GM releases it.
    if (!inst || !socket || !controls.enabled) return;
    if (selectedObject) deselectObject({ restoreContext: false });
    if (workspace) workspace.closeInspector();
    if (cameraFly) cameraFly.cancel();
    pendingViewPose = null;
    const pos = inst.position || { x: 0, y: 0, z: 0 };
    if (inst.mapKey === currentMapKey || inst.mapKey === roomKeyOf(currentMapKey)) {
        jumpCameraTo(pos);
        return;
    }
    currentMapKey = inst.mapKey;
    pendingFocus = { ...pos };
    socket.emit('join-map', { key: inst.mapKey });
}

function renderInstanceList() {
    const list = document.getElementById('character-instance-list');
    if (!list) return;
    list.innerHTML = '';
    if (!characterInstances.length) {
        list.innerHTML = '<p style="font-size: 12px; color: #999;">No characters on any map yet.</p>';
        return;
    }
    const instanceGroups = new Map();
    characterInstances.forEach(inst => {
        const key = inst.charId || `${inst.owner || ''}:${inst.charName || ''}`;
        if (!instanceGroups.has(key)) instanceGroups.set(key, []);
        instanceGroups.get(key).push(inst);
    });
    instanceGroups.forEach(group => group.sort((a, b) => String(a.id).localeCompare(String(b.id))));
    characterInstances.forEach(inst => {
        const row = document.createElement('div');
        row.className = 'instance-row';
        if (inst.color) row.style.borderLeftColor = inst.color;

        const main = document.createElement('button');
        main.className = 'instance-row-main';
        main.type = 'button';
        main.title = 'Click: jump to this token';

        const name = document.createElement('div');
        name.className = 'inst-name';
        const group = instanceGroups.get(inst.charId || `${inst.owner || ''}:${inst.charName || ''}`) || [inst];
        const ordinal = group.indexOf(inst) + 1;
        name.textContent = `${inst.charName || 'Unnamed'}${group.length > 1 ? ` · ${ordinal} of ${group.length}` : ''}`;
        if (inst.color) name.style.color = inst.color;

        const loc = document.createElement('div');
        loc.className = 'inst-loc';
        const p = inst.position || {};
        loc.textContent = `${inst.mapName || inst.mapKey} (${Math.round(p.x || 0)}, ${Math.round(p.z || 0)})`;

        const by = document.createElement('div');
        by.className = 'inst-by';
        by.textContent = `Spawned by ${inst.addedBy || 'unknown'}`;

        main.append(name, loc, by);
        main.addEventListener('click', () => gotoInstance(inst));

        const remove = document.createElement('button');
        remove.className = 'instance-row-delete';
        remove.type = 'button';
        remove.title = 'Delete this character token';
        remove.setAttribute('aria-label', `Delete ${inst.charName || 'character token'}`);
        remove.textContent = '×';
        remove.addEventListener('click', event => {
            event.stopPropagation();
            if (!socket || !confirm(`Delete ${inst.charName || 'this character token'} from ${inst.mapName || inst.mapKey}?`)) return;
            socket.emit('delete-character-instance', { id: inst.id, mapKey: inst.mapKey });
        });

        row.append(main, remove);
        list.appendChild(row);
    });
}

function placeCharacterAt(worldPoint, supportY = null) {
    if (!placeCharacter || !socket) return;
    const heightScale = (placeCharacter.appearance && placeCharacter.appearance.height) || 1;
    const halfHeight = (1 * heightScale) / 2 * 0.4;
    const snapped = snapToGrid(worldPoint);
    // A clicked upper/basement floor wins; otherwise retain the terrain fallback.
    const base = Number.isFinite(supportY)
        ? supportY
        : (terrain && terrain.group.visible) ? terrain.sampleHeight(snapped.x, snapped.z) : 0;
    socket.emit('add-object', {
        type: 'character',
        characterData: placeCharacter,
        position: { x: snapped.x, y: base + halfHeight, z: snapped.z }
    });
    placeCharacter = null;
    setTool('move');
}

// --- Object Management ---
function replaceObjectGeometry(object, patch) {
    const index = objects.indexOf(object);
    if (index < 0) return object;
    const source = object.userData.objectData || {};
    const data = {
        ...source,
        ...patch,
        position: { x: object.position.x, y: object.position.y, z: object.position.z }
    };
    const replacement = buildObjectFromData(object.userData.syncId, data);
    if (!replacement) return object;
    const wasSelected = selectedObject === object;
    if (wasSelected) setObjectSelected(object, false);
    if (objectNameplates) objectNameplates.removeFrom(object);
    worldGroup.remove(object);
    disposeBuiltObject(object);
    worldGroup.add(replacement);
    objects[index] = replacement;
    if (wasSelected) {
        selectedObject = replacement;
        dragStartPos = replacement.position.clone();
        setObjectSelected(replacement, true);
    }
    applyPlayerLevelVisibility();
    return replacement;
}

function createObjectFromData(id, data) {
    const mesh = buildObjectFromData(id, data);
    if (mesh) {
        worldGroup.add(mesh); // synced positions are world coords
        objects.push(mesh);
        applyPlayerLevelVisibility();
        if (objectNameplates) objectNameplates.sync(objects);
    }
}

function applyStructureBatchResult(result = {}) {
    const resultIsPocket = typeof result.key === 'string' && result.key.startsWith('pocket/');
    const currentIsPocket = currentMapKey.startsWith('pocket/');
    if (result.key && result.key !== currentMapKey && (resultIsPocket || currentIsPocket)) return;
    const created = Array.isArray(result.created) ? result.created : [];
    const updated = Array.isArray(result.updated) ? result.updated : [];
    const deleted = Array.isArray(result.deleted) ? result.deleted : [];
    for (const record of created) {
        if (record && record.id && !objects.some(object => object.userData.syncId === record.id)) {
            createObjectFromData(record.id, record);
        }
    }
    for (const entry of updated) {
        if (!entry || !entry.id || !entry.patch) continue;
        const object = objects.find(candidate => candidate.userData.syncId === entry.id);
        if (!object) continue;
        const type = object.userData.objectType;
        const geometryChanged = (type === 'wall' && Object.prototype.hasOwnProperty.call(entry.patch, 'segments')) ||
            ((type === 'floor' || type === 'roof') && Object.prototype.hasOwnProperty.call(entry.patch, 'tiles'));
        if (geometryChanged) replaceObjectGeometry(object, entry.patch);
        else updateObjectPresentation(object, entry.patch);
    }
    for (const entry of deleted) {
        const id = typeof entry === 'string' ? entry : entry && entry.id;
        const object = objects.find(candidate => candidate.userData.syncId === id);
        if (!object) continue;
        if (selectedObject === object) deselectObject();
        if (objectNameplates) objectNameplates.removeFrom(object);
        worldGroup.remove(object);
        objects = objects.filter(candidate => candidate !== object);
    }
    applyPlayerLevelVisibility();
    if (objectNameplates) objectNameplates.sync(objects);
}

function playerOwnsObject(object) {
    const char = object?.userData?.characterData;
    return !!(char && myUsername && char.owner === myUsername);
}

function playerModeLabel() {
    return ({ move: 'Move', ruler: 'Measure', place: 'Place' })[currentTool] || 'Explore';
}

function playerSelectionMetric(label, value) {
    return `<div class="selection-metric"><span>${escHtml(label)}</span><strong>${escHtml(value)}</strong></div>`;
}

function renderPlayerSelectionInspector({ open = true } = {}) {
    const object = selectedObject;
    const content = document.getElementById('selection-content');
    if (!object || !content) return;
    const id = object.userData.syncId;
    const data = object.userData.objectData || {};
    const char = object.userData.characterData || null;
    const monster = data.monsterData || null;
    const type = char ? 'character' : (object.userData.objectType || data.type || 'object');
    const identity = objectIdentity(object, objects);
    const combatant = combatState && combatState.combatants[id];
    const owner = char?.owner || '';
    const ownerLabel = /^gm$/i.test(owner) ? 'the GM' : owner;
    const typeLabel = char ? 'Character token' : ({ token: 'Creature token', portal: 'Portal', cave: 'Cave', arch: 'Rock arch', cube: 'Object', sphere: 'Object' }[type] || 'Map object');
    const effects = (Array.isArray(combatant?.effects) ? combatant.effects : [])
        .map(effect => EFFECTS[effect.key]?.label || effect.label || effect.key);
    const classes = (char?.classes || []).map(entry => `${entry.class || 'class'} ${entry.level || 1}`).join(' / ');
    const monsterMeta = monster
        ? `${monster.size || 'Medium'} ${monster.type || 'creature'}`
        : '';
    const meta = [typeLabel, identity.instanceText, owner ? `Controlled by ${ownerLabel}` : '', char?.race || '', classes, monsterMeta].filter(Boolean).join(' · ');

    const roundLabel = combatState?.round == null
        ? '—'
        : combatInteger(combatState.round, { fallback: 0, min: 0, max: 1000000 });
    const combatHTML = combatant ? `<div class="selection-section">
        <div class="selection-section-title"><span>Encounter</span><span>${combatState.started && combatState.activeId === id ? 'Active turn' : `Round ${escHtml(roundLabel)}`}</span></div>
        <div class="selection-metrics">
            ${playerSelectionMetric('HP', `${combatant.hp?.current ?? '—'}/${combatant.maxHP}`)}
            ${playerSelectionMetric('AC', combatant.ac)}
            ${playerSelectionMetric('Speed', `${combatInteger(combatant.speedFeet, { fallback: 0, min: 0, max: 1000000 })} ft`)}
            ${playerSelectionMetric('Initiative', combatant.initiative ?? '—')}
            ${playerSelectionMetric('Movement', combatState.activeId === id ? `${remainingFeet(combatant)} ft` : '—')}
            ${playerSelectionMetric('Conditions', effects.length || 0)}
        </div>
        ${effects.length ? `<div class="selection-effects" style="margin-top:8px">${effects.map(effect => `<span class="selection-effect active">${escHtml(effect)}</span>`).join('')}</div>` : ''}
    </div>` : '';

    const note = char
        ? `${ownerLabel === 'the GM' ? 'The GM' : (ownerLabel || 'The GM')} controls this character. Its game details are read-only here.`
        : 'The GM controls this map object. You can inspect it and focus your camera without changing it.';
    content.innerHTML = `<div class="selection-hero" style="--selection-color:${escHtml(identity.color)}">
            <span class="selection-color"></span>
            <div><span class="selection-name">${escHtml(identity.displayName)}</span><span class="selection-meta">${escHtml(meta)}</span></div>
        </div>
        ${combatHTML}
        <div class="selection-section">
            <div class="selection-section-title"><span>Location</span></div>
            <div class="selection-metrics">
                ${playerSelectionMetric('X', Math.round(object.position.x))}
                ${playerSelectionMetric('Y', Number(object.position.y).toFixed(1))}
                ${playerSelectionMetric('Z', Math.round(object.position.z))}
            </div>
        </div>
        <div class="selection-section"><div class="selection-readonly">${escHtml(note)}</div>
            <div class="selection-actions">
                <button type="button" class="selection-button primary wide" data-player-selection-act="focus">Focus camera</button>
                ${type === 'portal' && object.userData.portalTarget ? '<button type="button" class="selection-button wide" data-player-selection-act="portal">Enter portal</button>' : ''}
            </div>
        </div>`;

    content.querySelectorAll('[data-player-selection-act]').forEach(button => button.addEventListener('click', () => {
        if (selectedObject !== object) return;
        if (button.dataset.playerSelectionAct === 'focus') jumpCameraTo(object.position);
        if (button.dataset.playerSelectionAct === 'portal' && socket && object.userData.portalTarget) {
            currentMapKey = object.userData.portalTarget;
            socket.emit('join-map', { key: currentMapKey });
        }
    }));

    if (open && workspace) {
        workspace.showPanel('selection-panel', identity.displayName, typeLabel);
        if (currentTool == null) workspace.setMode('Inspect');
    }
}

function selectObject(object, { openInspector = true } = {}) {
    if (!object) return;
    if (!selectedObject && workspace && openInspector) {
        selectionReturnContext = { panel: workspace.currentPanel(), open: workspace.isInspectorOpen() };
    }
    if (selectedObject) deselectObject({ restoreContext: false, preserveReturn: true });
    selectedObject = object;
    dragStartPos = object.position.clone(); // combat movement is measured from here
    setObjectSelected(object, true);
    selectionOwnsInspector = openInspector;

    const char = object.userData.characterData;
    if (openInspector && char && playerOwnsObject(object)) {
        activeCharId = char.id;
        renderHUD();
        showCharacterPanel('char-panel');
    } else if (openInspector) {
        renderPlayerSelectionInspector({ open: true });
    }
    updatePlayerHintBar();
}

function deselectObject({ restoreContext = true, preserveReturn = false } = {}) {
    if (selectedObject) setObjectSelected(selectedObject, false);
    selectedObject = null;
    dragStartPos = null;
    hideMoveTooltip();
    const selectionPanels = new Set(['selection-panel', 'hud-panel-overlay']);
    if (restoreContext && selectionOwnsInspector && workspace && selectionPanels.has(workspace.currentPanel())) {
        const context = selectionReturnContext;
        if (context?.open && context.panel && !selectionPanels.has(context.panel)) workspace.showPanel(context.panel);
        else workspace.closeInspector();
        workspace.setMode(playerModeLabel());
    }
    if (!preserveReturn) {
        selectionReturnContext = null;
        selectionOwnsInspector = false;
    }
    updatePlayerHintBar();
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
    const previousActiveId = combatState && combatState.activeId;
    const hadCombat = !!combatState;
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
    if (workspace) {
        workspace.setDockVisible(!!combat);
        const active = combat?.started && combat.combatants[combat.activeId];
        const activeObject = active && findObjectMesh(active.id);
        const activeName = activeObject ? objectIdentity(activeObject, objects).displayName : active?.name;
        const myTurn = !!(active && active.owner === myUsername);
        const gathering = combat && !combat.started ? `${Object.keys(combat.combatants).length} combatants · Roll initiative` : '';
        const status = !combat ? 'Waiting for the GM'
            : myTurn ? `Your turn · ${remainingFeet(active)} ft left`
                : active ? `Round ${combat.round} · ${activeName}`
                    : gathering || `Round ${combat.round || '—'}`;
        workspace.setEncounterStatus(status, !!combat, myTurn);
        if (combat && (!hadCombat || (myTurn && previousActiveId !== combat.activeId))) workspace.setDockExpanded(true);
    }
    if (!combat) { pendingAttack = null; pendingSpell = null; hideMoveTooltip(); }
    if (selectedObject && !playerOwnsObject(selectedObject)) renderPlayerSelectionInspector({ open: false });
    updatePlayerHintBar();
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
    pendingSpell = null;
    pendingAttack = { combatantId, attackIndex };
    closeAllPanels();
    if (combatTracker) combatTracker.flash(`Pick a target for ${attack.name}: click a token (Esc cancels)`);
    updatePlayerHintBar();
}

function beginSpellPick(combatantId, spellIndex, spell) {
    pendingAttack = null;
    pendingSpell = { combatantId, spellIndex };
    closeAllPanels();
    if (combatTracker) combatTracker.flash(`Pick a target for ${spell.name}: click a token (Esc cancels)`);
    updatePlayerHintBar();
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

    const selectedToken = selectedObject?.userData?.characterData?.id === char.id && playerOwnsObject(selectedObject)
        ? objectIdentity(selectedObject, objects) : null;
    const tokenContext = selectedToken ? `<div class="selection-token-context">
        <span>${escHtml(selectedToken.displayName)} · selected on this map</span>
        <span><button class="selection-button" type="button" data-owned-token-act="focus">Focus</button> <button class="selection-button" type="button" data-owned-token-act="instances">Instances</button> <button class="selection-button primary" type="button" data-owned-token-act="move">Move</button></span>
    </div>` : '';

    cc.innerHTML = `${tokenContext}${selectorHTML(char.id)}
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
    cc.querySelectorAll('[data-owned-token-act]').forEach(button => button.onclick = () => {
        if (!selectedObject || !playerOwnsObject(selectedObject)) return;
        if (button.dataset.ownedTokenAct === 'focus') jumpCameraTo(selectedObject.position);
        if (button.dataset.ownedTokenAct === 'move') setTool('move', { preserveSelection: true });
        if (button.dataset.ownedTokenAct === 'instances') {
            deselectObject({ restoreContext: false });
            setCharacterTab('instances');
            showCharacterPanel('character-menu');
        }
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
        const activeObject = findObjectMesh(c.id);
        const activeLabel = activeObject ? objectIdentity(activeObject, objects).displayName : c.name;
        const dis = c.actionUsed ? 'disabled' : '';
        const atkBtns = (Array.isArray(c.attacks) ? c.attacks : []).map((a, i) =>
            `<button class="btn-combat atk" data-combat-atk="${i}" ${dis}>⚔ ${escHtml(a?.name)} <span class="tag">${combatModifier(a?.attack)} · ${escHtml(combatAttackDamageLabel(a))}</span></button>`
        ).join('') || '<p class="muted">No attacks.</p>';
        const spellBtns = (Array.isArray(c.spells) ? c.spells : []).map((spell, i) => {
            const spellLevel = combatSpellLevel(spell?.level);
            const slots = combatInteger(c.slots?.[spellLevel], { fallback: 0, min: 0, max: 99 });
            const spellDis = c.actionUsed || (spellLevel > 0 && slots < 1) ? 'disabled' : '';
            const level = spellLevel === 0 ? 'Cantrip' : `L${spellLevel}`;
            return `<button class="btn-combat" data-combat-spell="${i}" ${spellDis}>✨ ${escHtml(spell?.name)} <span class="tag">${level} · ${escHtml(spell?.damage)} ${escHtml(spell?.damageType)}</span></button>`;
        }).join('') || '<p class="muted">No spells.</p>';
        const round = combatInteger(combatState.round, { fallback: 1, min: 0, max: 1000000 });
        const speed = combatInteger(c.speedFeet, { fallback: 0, min: 0, max: 1000000 });
        ac.innerHTML = `
            <div class="row-item"><span>▶ ${escHtml(activeLabel)}'s turn — Round ${round}</span><b>${remainingFeet(c)} ft left</b></div>
            ${c.actionUsed ? '<p class="muted">Action used this turn — you can still move, then end your turn.</p>' : ''}
            <h4>Attacks</h4>
            <div class="combat-actions-list">${atkBtns}</div>
            <h4>Spells</h4>
            <div class="combat-actions-list">${spellBtns}</div>
            <h4>Other Actions</h4>
            <div class="combat-actions-list">
                <button class="btn-combat" data-combat-act="dash" ${dis}>💨 Dash <span class="tag">+${speed} ft move</span></button>
                <button class="btn-combat" data-combat-act="dodge" ${dis}>🛡 Dodge <span class="tag">attacks vs you at disadv.</span></button>
                <button class="btn-combat" data-combat-act="disengage" ${dis}>↪ Disengage</button>
                <button class="btn-combat end" data-combat-act="end-turn">■ End Turn</button>
            </div>`;
        ac.querySelectorAll('[data-combat-atk]').forEach(btn => btn.onclick = () => {
            const i = +btn.dataset.combatAtk;
            if (c.attacks[i]) beginTargetPick(c.id, i, c.attacks[i]);
        });
        ac.querySelectorAll('[data-combat-spell]').forEach(btn => btn.onclick = () => {
            const i = +btn.dataset.combatSpell;
            if (c.spells[i]) beginSpellPick(c.id, i, c.spells[i]);
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
    const activeObject = active && findObjectMesh(active.id);
    const activeLabel = activeObject ? objectIdentity(activeObject, objects).displayName : active?.name;
    const waiting = combatState && combatState.started
        ? `<p class="muted">⚔ Combat — waiting for ${escHtml(activeLabel || '…')}'s turn.</p>` : '';
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
function setTool(toolName, { preserveSelection = false } = {}) {
    if (selectedObject && !preserveSelection) deselectObject({ restoreContext: false });
    if (currentTool === 'ruler' && toolName !== 'ruler') {
        ruler.clearAll(() => { if (socket) socket.emit('clear-rulers'); });
    }
    if (toolName !== 'ruler') {
        ruler.hideTooltip();
    }
    if (toolName !== 'place') placeCharacter = null;
    currentTool = toolName;
    for (const key in toolMenuButtons) {
        toolMenuButtons[key].classList.toggle('active', key === toolName);
    }
    if (workspace) {
        workspace.setMode({ move: 'Move', ruler: 'Measure', place: 'Place' }[toolName] || 'Explore');
        workspace.closeInspector();
    }
    syncCharacterMenuActive();
    updatePlayerHintBar();
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
    if (window.__dbg) window.__dbg.socket = socket; // headless testing
    combatTracker = new CombatTracker({
        container: document.getElementById('combat-tracker'),
        socket, isGM: false, username,
        onPickTarget: (id, index, item, mode) => mode === 'cast'
            ? beginSpellPick(id, index, item)
            : beginTargetPick(id, index, item),
        onFocusCombatant: (id) => {
            const object = findObjectMesh(id);
            if (!object) return;
            selectObject(object, { openInspector: false });
            jumpCameraTo(object.position);
        },
        getMapObjects: () => objects.map(object => ({
            id: object.userData.syncId,
            name: objectIdentity(object, objects).displayName,
            type: object.userData.characterData ? 'character' : object.userData.objectType
        }))
    });

    socket.on('connect', () => {
        mapReload.onConnect();
        console.log('Conectado ao servidor com ID:', socket.id);
        socket.emit('login', username);
        sessionStorage.setItem('vtt_username', username);
    });

    socket.on('login-success', (userData) => {
        mapReload.onAuthenticated();
        console.log('Jogador autenticado:', userData);
        if (workspace) workspace.setUser(userData.username);
        login.hide();
        // Rejoin only after application authentication. A delayed pre-login
        // snapshot must not satisfy reconnect recovery.
        if (currentMapKey !== 'world') socket.emit('join-map', { key: currentMapKey });
    });

    // --- Character data for the HUD ---
    socket.on('load-user-characters', (chars) => {
        myCharacters = Array.isArray(chars) ? chars : [];
        if (!myCharacters.find(c => c.id === activeCharId)) {
            activeCharId = myCharacters[0] ? myCharacters[0].id : null;
        }
        renderHUD();
        renderCharacterMenu();
        answerStatsPending(); // combat may have arrived before the characters
    });

    // Instances tab: where my character tokens sit, across every map. Pushed
    // by the server on any character add/move/delete and re-requested on tab open.
    socket.on('character-instances', (data) => {
        characterInstances = (data && Array.isArray(data.instances)) ? data.instances : [];
        renderInstanceList();
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
        renderCharacterMenu();
    });

    socket.on('character-deleted', (charId) => {
        myCharacters = myCharacters.filter(c => c.id !== charId);
        if (activeCharId === charId) activeCharId = myCharacters[0] ? myCharacters[0].id : null;
        renderHUD();
        renderCharacterMenu();
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

    // GM-directed camera (View control): fly or snap to a world-space pose the
    // GM chose, optionally locking the controls until camera-unlock. Long jumps
    // snap regardless of mode — a cross-continent glide would drag dozens of
    // floating-origin rebases (and minutes of terrain streaming) behind it.
    function applyViewPose(pose, mode, lock) {
        setViewLock(!!lock);
        const origin = terrain.worldOrigin;
        const dist = Math.hypot(pose.look.x - (controls.target.x + origin.x),
                                pose.look.z - (controls.target.z + origin.z));
        if (mode === 'snap' || dist > 20000) {
            cameraFly.cancel();
            // Re-seat the floating origin at the destination (mirrors the
            // map-state worldCenter landing) so scene coords start near zero.
            // Pockets keep their pinned origin — they live near 0 anyway.
            const o = terrainIsUnified
                ? setWorldOriginAt({ terrain, worldGroup }, pose.look.x, pose.look.z)
                : origin;
            camera.position.set(pose.pos.x - o.x, pose.pos.y, pose.pos.z - o.z);
            controls.target.set(pose.look.x - o.x, pose.look.y, pose.look.z - o.z);
        } else {
            cameraFly.start(pose, origin);
        }
    }
    socket.on('camera-goto', ({ pose, mode, lock, mapKey } = {}) => {
        if (!pose || !pose.pos || !pose.look) return;
        // A GM command supersedes an unfinished Instances jump. If another map
        // state is already in flight, retain the newest GM pose and apply it
        // only after that state has loaded instead of briefly steering the old
        // scene and then being overwritten by the join response.
        const waitingForMap = !!pendingFocus || !!pendingViewPose;
        pendingFocus = null;
        // Relocate: the GM is on another map/tier — join it and land on the pose
        // once that map-state arrives (mirrors focusInstance's pendingFocus).
        if (mapKey && (mapKey !== currentMapKey || waitingForMap)) {
            const needsJoin = mapKey !== currentMapKey;
            currentMapKey = mapKey;
            pendingViewPose = { pose, mode, lock };
            setViewLock(!!lock);
            if (needsJoin) socket.emit('join-map', { key: mapKey });
            return;
        }
        pendingViewPose = null;
        applyViewPose(pose, mode, lock);
    });
    socket.on('camera-unlock', () => {
        // Release also updates a relocation that is still waiting on map-state;
        // otherwise its stale lock flag would re-lock the player on arrival.
        if (pendingViewPose) pendingViewPose.lock = false;
        setViewLock(false);
    });

    // Full map state on connect
    socket.on('map-state', (data) => {
        if (!mapReload.acceptsMapState(data.key, currentMapKey)) return;
        restorePlayerCutaway();
        levelView.active = 0;
        levelView.isolate = false;
        if (workspace) {
            const location = data.meta && data.meta.name
                ? data.meta.name
                : (data.unified ? 'Shared world' : (data.key || 'World'));
            workspace.setLocation(location);
        }
        // A map switch resets the camera context: abort any GM-directed flight
        // and drop a stale view lock (the GM can re-lock on the new map).
        if (cameraFly) cameraFly.cancel();
        setViewLock(false);
        if (selectedObject) deselectObject();
        if (objectNameplates) objectNameplates.clear(objects);
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
                // Fog of war: adopt the server's revealed set and show the fog
                // sheet (the server already withheld hidden objects/chunks).
                fogMask.setList(data.fog || []);
                if (fogOverlay) fogOverlay.setVisible(true);
                // One continuous world: load once, then fly between provinces.
                if (mapReload.shouldReplaceUnified(terrainIsUnified)) {
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
                // Pockets are never fogged (entering one means you're inside).
                if (fogOverlay) fogOverlay.setVisible(false);
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

        // Instances-tab travel: we joined this map to find a token — jump to it
        // (after the terrain/worldCenter landing above so the jump wins).
        if (pendingFocus) { jumpCameraTo(pendingFocus); pendingFocus = null; }
        // A GM "Bring to my view" that crossed maps: land on the pose now that
        // the target map is loaded (snap — we just teleported here).
        if (pendingViewPose) { applyViewPose(pendingViewPose.pose, 'snap', pendingViewPose.lock); pendingViewPose = null; }
        applyPlayerLevelVisibility();
        mapReload.onMapStateApplied();
    });

    // Live terrain edits from the GM (partial chunk payload).
    socket.on('terrain-updated', (data) => {
        if (terrain) {
            terrain.applyData(data);
            terrain.group.visible = true;
            styleGroundForTerrain(plane, true);
            applyPlayerLevelVisibility();
        }
    });

    // Regional and pocket resets are published only after the server commits
    // chunks and water together. Apply that canonical result exactly like a
    // live terrain update, then reassert any basement cutaway.
    socket.on('terrain-reset-applied', (data) => {
        const belongsHere = data?.scope === 'map'
            ? data.contextKey === currentMapKey
            : data?.scope === 'province' ? terrainIsUnified : true;
        if (terrain && belongsHere) {
            terrain.applyData(data);
            terrain.group.visible = true;
            styleGroundForTerrain(plane, true);
            applyPlayerLevelVisibility();
        }
    });

    // Fog of war: the GM revealed or hid regions. Revealed content (objects,
    // terrain chunks) arrives via the normal object-added/terrain-updated
    // events; on hide the server sends object deletes and we drop our copy of
    // any GM-edited chunks there (the ground falls back to the generator).
    socket.on('fog-updated', ({ hexes, revealed }) => {
        if (!Array.isArray(hexes)) return;
        for (const hk of hexes) fogMask.set(hk, revealed);
        if (!revealed && terrain && terrainIsUnified) {
            const hidden = new Set(hexes);
            const del = {};
            for (const [k, c] of terrain.chunks) {
                if (!c.generated && hidden.has(chunkFogHexKey(k))) del[k] = null;
            }
            if (Object.keys(del).length) terrain.applyData({ chunks: del });
        }
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
            updateObjectPositionData(object);
            if (selectedObject === object && !playerOwnsObject(object)) renderPlayerSelectionInspector({ open: false });
        }
    });

    socket.on('object-updated', ({ id, patch } = {}) => {
        const object = objects.find(o => o.userData.syncId === id);
        if (!object || !patch) return;
        const type = object.userData.objectType;
        const geometryChanged = (type === 'wall' &&
            Object.prototype.hasOwnProperty.call(patch, 'segments')) ||
            ((type === 'floor' || type === 'roof') &&
                Object.prototype.hasOwnProperty.call(patch, 'tiles'));
        const updated = geometryChanged
            ? replaceObjectGeometry(object, patch)
            : object;
        if (updated === object) updateObjectPresentation(object, patch);
        if (objectNameplates) objectNameplates.sync(objects);
        if (selectedObject === updated && !playerOwnsObject(updated)) renderPlayerSelectionInspector({ open: false });
    });

    socket.on('structure-batch-applied', (result) => applyStructureBatchResult(result));

    socket.on('object-deleted', (data) => {
        const object = objects.find(o => o.userData.syncId === data.id);
        if (object) {
            if (selectedObject === object) deselectObject();
            if (objectNameplates) objectNameplates.removeFrom(object);
            worldGroup.remove(object);
            objects = objects.filter(o => o.userData.syncId !== data.id);
            applyPlayerLevelVisibility();
            if (objectNameplates) objectNameplates.sync(objects);
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
        mapReload.onDisconnect();
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
