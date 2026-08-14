// gm.js — GM screen (/gm): three-layer map navigation (World → Region → Tactical),
// object placement, terrain sculpting/painting/water, rulers, and Socket.IO sync.
// Scene boilerplate, meshes and the ruler tool live in ../shared/.

import * as THREE from 'three';
import { Terrain, MATERIALS } from '../shared/terrain.js';
import { Grass } from '../shared/grass.js';
import { Trees } from '../shared/trees.js';
import { createTabletopScene, startRenderLoop, castFromPointer, snapToGrid, trackRightDrag, styleGroundForTerrain, buildBoundsRect, updateWorldFollow, setWorldOriginAt, maybeRebaseWorld, FOG_NEAR, FOG_FAR, GRID_CELL_SIZE, FEET_PER_GRID_CELL } from '../shared/scene.js';
import { buildObjectFromData, applyMove } from '../shared/models.js';
import { loadSRD, loadSRDMonsters } from '../shared/srd.js';
import {
    monsterChallengeLabel, monsterColor, monsterCombatStats, monsterStatBlockHTML, monsterTokenSnapshot
} from '../shared/monsters.js';
import { CombatTracker, CombatOverlays, deriveCombatStats, EFFECTS, remainingFeet } from '../shared/combat.js';
import { combatInteger } from '../shared/combat-safety.js';
import { tickRigCharacters } from '../shared/charmesh.js';
import {
    buildWallRun, buildFloorPatch, buildStaircase, buildRoofPatch, disposeBuiltObject,
    wallGesturePath, wallSegmentCount, structureTileCount,
    DEFAULT_LEVEL_HEIGHT, STRUCTURE_EDIT_PICK_LAYER,
    structureLevel, structureTouchesLevel, structureStoreyLevel,
    structureBuildingId, structureBuildingDatum, structureDatumCompatible,
    newStructureIdentity, isStructureType
} from '../shared/structures.js';
import { TIER_WIDTH, tierRadius, hexCenterAtTier, worldToHexAtTier, hexDistance, hexInField, pathWorldCenter } from '../shared/hexworld.js';
import { FogMask, FogOverlay, fogHexAt, hexesWithin } from '../shared/fog.js';
import { RulerTool } from '../shared/rulers.js';
import { bindLongPress, dismissSubmenusOnOutsideClick } from '../shared/ui.js';
import { createTabletopWorkspace } from '../shared/workspace.js';
import { ObjectNameplates, objectIdentity, setObjectSelected, updateObjectPresentation, updateObjectPositionData } from '../shared/object-ui.js';
import { AuthenticatedMapReload } from '../shared/sync-state.js';

const escHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --- Terrain editor state (tactical layer only) ---
let terrain = null;
let grass = null;                   // instanced ground-cover grass (shared/grass.js)
let trees = null;                   // procedural low-poly trees (shared/trees.js)
let isSculpting = false;
let strokeRef = 0;                         // flatten target captured at stroke start
let lastDab = null;                        // last dab position, for fixed-spacing strokes
let shiftDown = false;                     // Shift inverts raise<->lower while held
const terrainBrush = { mode: 'raise', radius: 6, strength: 0.35, material: 0, flattenRef: null };

// Undo/redo: copy-on-write patches of only the chunks each stroke touched.
const UNDO_LIMIT = 20;
const undoStack = [], redoStack = [];
let pendingTerrainReset = null;             // one requestId + pre-ack undo context

// Ramp gesture state (click-drag a line, applied on release) + its preview line.
let rampStart = null;                      // { x, z, h }
let rampPreview = null;

// Brush cursor tint per mode (paint uses the selected material's color).
const BRUSH_COLORS = {
    raise: 0x7cdf70, lower: 0xff6b5e, smooth: 0x6ec6ff,
    flatten: 0xc79bff, noise: 0xffb74d, terrace: 0xffe97a, ramp: 0xff9ff3,
    paint: 0xffffff, lake: 0x4dc3ff, river: 0x7ad7ff
};

// Lake gesture: pointerdown pours (or grabs) a lake; vertical drag sets its
// level live; release commits + syncs. { id, startLevel, startClientY, before }
let lakeDrag = null;

// River draft: clicked waypoints awaiting Enter/double-click commit.
let riverDraft = null;   // { points: [{x,z}] }
let riverPreview = null; // polyline following the draft + cursor

// --- Build tool (tile brush) state: walls/floors/stairs/roofs dragged on the grid.
// Level 0 may follow terrain (legacy behavior). Other levels share a flat datum
// and are separated by levelHeight, so independent drags stay perfectly aligned.
const buildBrush = {
    mode: 'wall', style: 'stone', scruffy: false, wallHeight: 2,
    level: 0, levelHeight: DEFAULT_LEVEL_HEIGHT, datumY: null,
    followTerrain: true, autoSnap: true, isolate: false,
    stairDirection: 1, openingKind: 'door', tileKind: 'gap',
    roofShape: 'gable-x', roofPitch: 0.5, pickingLevel: false,
    buildingId: newStructureIdentity('building'), buildingPickMode: null
};
const BUILD_LEVEL_MIN = -5, BUILD_LEVEL_MAX = 8;
const MAX_RUN = 48;                        // cells per gesture (walls and floor sides)
let buildDrag = null;                      // gesture anchor + resolved level/base height
let buildGhost = null;                     // translucent preview in worldGroup
let buildGhostKey = '';                    // memo: rebuild only when the snap changes
let buildCutawayState = null;               // terrain/plane visibility before basement cutaway
const pendingStructureBatches = new Map();  // requestId -> local UX context

let wasRightDrag = null;                   // set in init(); see trackRightDrag

// --- Fog of war (U4): GM paints reveal/hide on the global province-pitch
// lattice; players only receive content inside revealed hexes (server-side).
const fogMask = new FogMask();             // mirrors the server's revealed set
const fogBrush = { mode: 'reveal', radius: 1 };
let fogOverlay = null;                     // dim sheet while the tool is active
let fogStroke = null;                      // Set of hexes touched this drag

// --- View tool: steer player cameras (camera-command → camera-goto relay).
// target is 'all' or a lowercased username; action decides what a map click
// sends (frame a ground point vs frame a clicked token).
const viewCtl = { target: 'all', action: 'point', fly: true, lock: false };
let playersRoster = [];                    // players-updated presence roster
let viewStatusTimer = null;                // clears the panel status line

let scene, camera, renderer, controls, plane, grid, raycaster, mouse, dirLight, worldGroup;
let ruler;
let objects = [];
let selectedObject = null;
let selectedObjectType = null;
let selectedObjectData = null;
let menuButtons = {};

let socket;
let workspace = null;
let objectNameplates = null;
let selectionReturnContext = null;

// --- Combat mode (server-authoritative; the GM runs it from the tracker) ---
let SRD = null;                 // loaded lazily: combat stat derivation only
let pendingHomebrew = null;
let srdMonsters = [];
let customMonsters = [];
let monsterLoadError = '';
let monsterCatalogState = 'idle';
let monsterCatalogPromise = null;
let allCharacters = [];         // GM sees every character (stat-fill fallback)
let characterInstances = [];    // every placed character token across all maps (Instances tab)
let pendingFocus = null;        // world position to land on once the next map-state arrives
let combatState = null;
let combatTracker = null;
let combatOverlays = null;
let pendingAttack = null;       // { combatantId, attackIndex } while picking a target
let pendingSpell = null;        // { combatantId, spellIndex } while picking a target
let dragStartPos = null;        // selected token's world position when the move began

let currentTool = null;
let currentMoveMode = 'standard';
let toolMenuButtons = {};
let moveSubMenuButtons = {};
let moveSubMenu;
let isDraggingHeight = false;

let rulerSubMenu, rulerSubMenuButtons = {};
let rulerSnapSubMenuButtons = {};

// ===== Map tree (DMG scale ladder, p14) + pocket maps =====
// A map is identified by a path key:
//   "world"                depth 0  -> Continent hexes, 60 miles per hex
//   "world/q,r"            depth 1  -> Kingdom hexes, 6 miles per hex
//   "world/q,r/q,r"        depth 2  -> Province hexes, 1 mile per hex
//   "world/q,r/q,r/q,r"    depth 3  -> square grid, 5 ft per cell (tactical)
//   "pocket/<id>"          pocket   -> square grid dungeon/room, entered via portals
let currentMapKey = 'world';
let currentMapMeta = null;          // pocket metadata ({kind,name,width,height,parentKey})
let terrainIsUnified = false;       // is the loaded terrain the shared continuous world?
const mapReload = new AuthenticatedMapReload();
let hexGridGroup = null;
let boundsRect = null;              // pocket boundary rectangle
let pendingPortal = null;           // portal placement waiting for 'pocket-created'

// Biome tags on hex layers: color the hexes and seed new tactical maps below.
const BIOMES = {
    plains:    { color: 0x8bc34a, label: 'Plains' },
    forest:    { color: 0x2e7d32, label: 'Forest' },
    mountains: { color: 0x8d8d93, label: 'Mountains' },
    desert:    { color: 0xd7b26a, label: 'Desert' },
    swamp:     { color: 0x4e5f3a, label: 'Swamp' },
    coast:     { color: 0x4aa3c7, label: 'Coast' }
};
let currentBiome = 'plains';
let hexTags = {};                   // "q,r" -> { biome } for the current map
let hexTree = {};                   // all layers' tags (feeds the terrain generator)
let regenTimer = null;              // debounce for biome-driven regeneration
let hexFillGroup = null;            // colored hex fill overlay

const TACTICAL_DEPTH = 3;      // depth of the square-grid leaf
// DMG p14 hex scales per depth (hex layers only).
const HEX_SCALES = {
    0: { miles: 60, label: 'Continent' },
    1: { miles: 6,  label: 'Kingdom' },
    2: { miles: 1,  label: 'Province' }
};

// Overlay lines/fills draw on top of the 3D world regardless of relief
// (depthTest off) — they're a map annotation, not scene geometry.
const hexLineMaterial = new THREE.LineBasicMaterial({ color: 0xdddddd, transparent: true, opacity: 0.4, depthTest: false });

function mapDepth(key) { return key.split('/').length - 1; }      // 0..2 hex layers, 3 tactical
function isPocket(key = currentMapKey) { return key.startsWith('pocket/'); }
// Square-grid maps with editable terrain: hex-tree leaves and pocket dungeons.
function isTacticalKey(key = currentMapKey) { return isPocket(key) || mapDepth(key) >= TACTICAL_DEPTH; }
function isHexLayer(depth = mapDepth(currentMapKey)) { return !isPocket(currentMapKey) && depth < TACTICAL_DEPTH; }

// --- World-scale hex lenses (shared math in hexworld.js) ---
// Hexes live at TRUE world scale: a hex at depth d is TIER_WIDTH[d] units
// across, and each layer's field is centered on its parent hex's center.
let layerCenter = { x: 0, z: 0 };   // world center of the current layer's field
function layerDepth() { return Math.min(mapDepth(currentMapKey), 2); }
// Hex (q,r) of the current layer's field containing a WORLD point.
function worldToHex(x, z) {
    return worldToHexAtTier(layerDepth(), x - layerCenter.x, z - layerCenter.z);
}
// WORLD center of hex (q,r) in the current layer's field.
function hexToWorld(q, r) {
    const c = hexCenterAtTier(layerDepth(), q, r);
    return { x: layerCenter.x + c.x, z: layerCenter.z + c.z };
}
function hexCorner(cx, cz, R, i) {
    const ang = Math.PI / 180 * (60 * i - 30); // pointy-top corners
    return new THREE.Vector3(cx + R * Math.cos(ang), 0, cz + R * Math.sin(ang));
}
// Hex outlines for the current layer, built LOCAL to the layer center (the
// group sits at layerCenter inside worldGroup, so float32 stays precise).
function buildHexGrid(depth) {
    const R = tierRadius(depth);
    const positions = [];
    for (let q = -6; q <= 6; q++) {
        for (let r = -6; r <= 6; r++) {
            if (!hexInField(q, r)) continue;
            const { x, z } = hexCenterAtTier(depth, q, r);
            const c = [];
            for (let i = 0; i < 6; i++) c.push(hexCorner(x, z, R, i));
            for (let i = 0; i < 6; i++) {
                const a = c[i], b = c[(i + 1) % 6];
                positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
            }
        }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const group = new THREE.Group();
    const lines = new THREE.LineSegments(geom, hexLineMaterial);
    lines.renderOrder = 10; // over terrain + water + fills
    group.add(lines);
    return group;
}
function showLayerGrid(key) {
    // The square grid is drawn in the terrain shader now; keep the old mesh off.
    if (grid) grid.visible = false;
    if (hexGridGroup) {
        worldGroup.remove(hexGridGroup);
        hexGridGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); });
        hexGridGroup = null;
    }
    if (!isPocket(key) && mapDepth(key) < TACTICAL_DEPTH) {
        hexGridGroup = buildHexGrid(mapDepth(key));
        hexGridGroup.position.set(layerCenter.x, 0, layerCenter.z);
        worldGroup.add(hexGridGroup);
    }
}

// Colored fills for biome-tagged hexes (hex layers only): a translucent
// annotation over the real terrain showing what's painted where.
function rebuildHexFills() {
    if (hexFillGroup) {
        worldGroup.remove(hexFillGroup);
        hexFillGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
        hexFillGroup = null;
    }
    if (!isHexLayer()) return;
    const depth = layerDepth();
    const R = tierRadius(depth);
    hexFillGroup = new THREE.Group();
    for (const hk of Object.keys(hexTags)) {
        const biome = BIOMES[hexTags[hk].biome];
        if (!biome) continue;
        const [q, r] = hk.split(',').map(Number);
        const { x, z } = hexCenterAtTier(depth, q, r); // local to layer center
        const shape = new THREE.Shape();
        for (let i = 0; i < 6; i++) {
            const c = hexCorner(x, z, R, i);
            if (i === 0) shape.moveTo(c.x, c.z); else shape.lineTo(c.x, c.z);
        }
        const geo = new THREE.ShapeGeometry(shape);
        geo.rotateX(Math.PI / 2); // shape XY -> ground XZ
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
            color: biome.color, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthTest: false
        }));
        mesh.renderOrder = 9; // over terrain, under the hex lines
        hexFillGroup.add(mesh);
    }
    hexFillGroup.position.set(layerCenter.x, 0, layerCenter.z);
    worldGroup.add(hexFillGroup);
}

// --- Layer-aware snapping & measurement ---
// Objects (tokens/minis/props) are tactical-scale entities in the one unified
// world, so they always snap to the fine tactical square grid — never the coarse
// hex-center snap of a zoom lens. Placing from Continent/Kingdom/Province zoom
// drops the object where you clicked (the 1u grid is far finer than the view),
// and focusCameraOn then flies you down to it. (Rulers snap to hex centers
// separately via getCurrentRulerSnap; that stays hex-aware.)
function snapToCurrentGrid(point) {
    return snapToGrid(point);
}
function getCurrentRulerSnap(point) {
    if (isHexLayer()) {
        const h = worldToHex(point.x, point.z);
        const c = hexToWorld(h.q, h.r);
        return new THREE.Vector3(c.x, 0.02, c.z);
    }
    return ruler.snap(point);
}
function measurePath(points) {
    // hex layers: sum of hex steps * miles per hex (DMG scales)
    const scale = HEX_SCALES[mapDepth(currentMapKey)];
    const miles = scale ? scale.miles : 0;
    let steps = 0;
    for (let i = 0; i < points.length - 1; i++) {
        steps += hexDistance(worldToHex(points[i].x, points[i].z), worldToHex(points[i + 1].x, points[i + 1].z));
    }
    return { value: steps * miles, unit: 'mi' };
}

const emitRuler = (data) => socket.emit('add-ruler', data);

// --- Drill-down navigation ---
function enterMap(key) {
    restoreBuildCutaway();
    currentMapKey = key;
    // World position of this layer's hex field (hex lenses are world-scale).
    layerCenter = isPocket(key) ? { x: 0, z: 0 } : pathWorldCenter(key);
    if (selectedObject) deselectObject();
    ruler.clearInProgress();
    // Fresh map, fresh viewpoint: standard overview centered on the origin.
    controls.target.set(0, 0, 0);
    camera.position.set(20, 30, 20);
    // reset tool state locally (no server side effects)
    selectedObjectType = null;
    selectedObjectData = null;
    currentTool = null;
    for (const k in toolMenuButtons) toolMenuButtons[k].classList.remove('active');
    document.querySelectorAll('#object-menu .menu-button, #object-menu .character-card-place').forEach(b => b.classList.remove('active'));
    // clear local scene; server repopulates via 'map-state' after join-map
    if (objectNameplates) objectNameplates.clear(objects);
    objects.forEach(o => worldGroup.remove(o));
    objects = [];
    ruler.removeSegments();
    showLayerGrid(key);
    // Hex tags + pocket metadata arrive with map-state; clear the old ones now.
    hexTags = {};
    rebuildHexFills();
    currentMapMeta = null;
    if (boundsRect) { scene.remove(boundsRect); boundsRect.geometry.dispose(); boundsRect = null; }
    // Hide terrain + its panel off the tactical leaf; map-state will repopulate it.
    if (terrain) terrain.group.visible = false;
    styleGroundForTerrain(plane, isTacticalKey(key)); // refined again by map-state
    isSculpting = false;
    lastDab = null;
    rampStart = null;
    lakeDrag = null;
    cancelRiverDraft();
    buildDrag = null;
    buildBrush.level = 0;
    buildBrush.datumY = null;
    buildBrush.isolate = false;
    buildBrush.pickingLevel = false;
    buildBrush.buildingId = newStructureIdentity('building');
    buildBrush.buildingPickMode = null;
    pendingStructureBatches.clear();
    setBuildBuildingStatus('New pieces share this building until you choose another.');
    clearBuildGhost();
    syncBuildControls();
    if (rampPreview) rampPreview.visible = false;
    if (terrain) terrain.setBrush({ visible: false });
    updateTerrainPanel();
    updateBreadcrumb();
    if (socket) socket.emit('join-map', { key });
}
function goUp() {
    if (isPocket()) {
        enterMap((currentMapMeta && currentMapMeta.parentKey) || 'world');
        return;
    }
    if (mapDepth(currentMapKey) <= 0) return;
    enterMap(currentMapKey.split('/').slice(0, -1).join('/'));
}
function descendInto(q, r) {
    if (mapDepth(currentMapKey) >= TACTICAL_DEPTH) return; // tactical is the leaf
    if (!hexInField(q, r)) return;
    enterMap(`${currentMapKey}/${q},${r}`);
}
function updateBreadcrumb() {
    const bc = document.getElementById('breadcrumb');
    const up = document.getElementById('btn-up');
    if (!bc) return;
    if (isPocket()) {
        const m = currentMapMeta;
        const name = (m && m.name) || 'Pocket map';
        const dims = m ? ` (${m.width}×${m.height})` : '';
        bc.textContent = `⌖ ${name}${dims}   —   each square = 5 ft`;
        if (up) up.disabled = false; // Up exits through the parent link
        return;
    }
    const segs = currentMapKey.split('/');
    const layerName = (d) => (HEX_SCALES[d] ? HEX_SCALES[d].label : 'Tactical');
    const labels = [layerName(0)];
    for (let i = 1; i < segs.length; i++) labels.push(layerName(i) + ' (' + segs[i] + ')');
    const depth = mapDepth(currentMapKey);
    const scale = HEX_SCALES[depth] ? `each hex = ${HEX_SCALES[depth].miles} mi` : 'each square = 5 ft';
    bc.textContent = labels.join('  ›  ') + '   —   ' + scale;
    if (up) up.disabled = (depth === 0);
}
function onDoubleClick(event) {
    // Double-click finishes a river draft.
    if (terrainActive() && terrainBrush.mode === 'river' && riverDraft && riverDraft.points.length >= 2) {
        commitRiver();
        return;
    }
    if (currentTool === 'add' || currentTool === 'move' || currentTool === 'ruler') return;
    castFromPointer(event, { renderer, camera, raycaster, mouse });

    // Portals first: double-click one to travel to its target map (any layer).
    const objHit = raycaster.intersectObjects(objects, true)[0];
    if (objHit) {
        let top = objHit.object;
        while (top.parent && top.parent !== scene && top.parent !== worldGroup) top = top.parent;
        const obj = objects.find(o => o === top);
        if (obj && obj.userData.objectType === 'portal' && obj.userData.portalTarget) {
            enterMap(obj.userData.portalTarget);
            return;
        }
    }

    // Hex layers: double-click a hex to descend.
    if (!isHexLayer()) return;
    const hit = raycaster.intersectObject(plane)[0];
    if (!hit) return;
    const p = sceneToWorld(hit.point);
    const h = worldToHex(p.x, p.z);
    descendInto(h.q, h.r);
}

// --- Socket.IO: GM auto-login + full map/character sync ---
function initSocket() {
    socket = io();

    combatTracker = new CombatTracker({
        container: document.getElementById('combat-tracker'),
        socket, isGM: true, username: 'GM',
        onPickTarget: (id, index, item, mode) => mode === 'cast'
            ? beginSpellPick(id, index, item)
            : beginTargetPick(id, index, item),
        onFocusCombatant: (id) => {
            const object = findObjectMesh(id);
            if (!object) return;
            selectObject(object, { openInspector: true });
            frameCameraOn(object.position);
        },
        // Candidates for the tracker's "+ add to combat" select.
        getMapObjects: () => objects.map(o => ({
            id: o.userData.syncId,
            type: o.userData.characterData ? 'character' : o.userData.objectType,
            name: objectIdentity(o, objects).displayName
        }))
    });
    const combatToggle = document.getElementById('btn-combat-toggle');
    if (combatToggle) combatToggle.addEventListener('click', () => socket.emit('combat-start', {}));

    socket.on('combat-updated', (combat) => setCombat(combat));
    socket.on('combat-log', (entry) => { if (combatTracker) combatTracker.appendLog(entry); });
    socket.on('combat-denied', ({ reason }) => { if (combatTracker) combatTracker.flash(reason || 'Not allowed'); });

    socket.on('connect', () => {
        mapReload.onConnect();
        clearPendingStructureBatches(
            'Connection restored; building state will be reloaded.', true);
        console.log('Conectado ao servidor com ID:', socket.id);
        // Auto-login as GM on this single connection
        socket.emit('login', 'GM');
        sessionStorage.setItem('vtt_username', 'GM');
    });

    socket.on('login-success', (userData) => {
        mapReload.onAuthenticated();
        console.log('GM logged in:', userData);
        const loginOverlay = document.getElementById('login-overlay');
        if (loginOverlay) loginOverlay.classList.add('hidden');
        // Rejoin only after application authentication. A delayed state from
        // an older/legacy pre-login path must not satisfy reconnect recovery.
        if (currentMapKey !== 'world') socket.emit('join-map', { key: currentMapKey });
    });

    socket.on('load-user-characters', (characters) => {
        allCharacters = Array.isArray(characters) ? characters : [];
        loadCharactersToMenu(characters);
        answerStatsPending(); // combat may be waiting on character stats
    });

    socket.on('character-updated', () => {
        socket.emit('get-characters'); // Refresh the menu
    });

    // Instances tab: every placed character token across every map (the GM sees
    // all owners). Seeded at login, re-pushed live on any add/move/delete.
    socket.on('character-instances', (data) => {
        characterInstances = (data && Array.isArray(data.instances)) ? data.instances : [];
        renderInstanceList();
    });

    // Homebrew races/classes feed character rules; custom monsters join the
    // GM's lazy SRD creature library.
    socket.on('load-homebrew', (hb) => {
        pendingHomebrew = hb;
        customMonsters = hb && Array.isArray(hb.monsters) ? hb.monsters : [];
        renderMonsterLibrary();
        if (SRD) { SRD.setHomebrew(hb); answerStatsPending(); }
    });

    // Full map state on connect / map switch
    socket.on('map-state', (data) => {
        // Only a matching post-login state may satisfy reconnect recovery.
        if (!mapReload.acceptsMapState(data.key, currentMapKey)) return;
        clearPendingStructureBatches(
            'Building state reloaded from the server. Retry any unfinished edit.');
        if (selectedObject) deselectObject();
        if (objectNameplates) objectNameplates.clear(objects);
        objects.forEach(obj => worldGroup.remove(obj));
        objects = [];
        ruler.removeSegments();

        data.objects.forEach(objData => createObjectFromData(objData.id, objData));
        data.rulers.forEach(rulerData => ruler.addFromData(rulerData.id, rulerData));
        setCombat(data.combat || null); // rejoin an in-progress fight fully synced

        // Biome tags for this map's hexes (hex layers only render them).
        hexTags = data.hexes || {};
        rebuildHexFills();

        // Fog-of-war mask (unified world states carry the revealed set).
        if (data.fog) fogMask.setList(data.fog);

        // Pocket metadata: name/dimensions drive the breadcrumb + boundary rect.
        currentMapMeta = data.meta || null;
        if (boundsRect) { scene.remove(boundsRect); boundsRect.geometry.dispose(); boundsRect = null; }
        if (currentMapMeta && currentMapMeta.kind === 'pocket') {
            boundsRect = buildBoundsRect(currentMapMeta.width, currentMapMeta.height);
            scene.add(boundsRect);
        }
        updateBreadcrumb();

        // Terrain.
        if (terrain) {
            // Painted hex biomes override generation everywhere (all layers).
            if (data.hexTree) {
                hexTree = data.hexTree;
                terrain.setBiomeOverrides(hexTree);
            }
            if (data.unified) {
                // One continuous world (tactical leaves AND hex-tier lenses):
                // load it once, then just fly the camera between layers (no
                // reload flash, no re-applying 1000s of chunks every hop).
                if (mapReload.shouldReplaceUnified(terrainIsUnified)) {
                    terrain.generatorOn = true;
                    terrain.reset();
                    undoStack.length = 0; redoStack.length = 0;
                    if (data.terrain) terrain.applyData(data.terrain);
                    terrainIsUnified = true;
                }
                terrain.group.visible = true;
                styleGroundForTerrain(plane, true);
                syncWaterControls();
                // The Fog tool may have been selected before this state landed.
                if (fogOverlay) fogOverlay.setVisible(fogActive());
                if (data.worldCenter) {
                    const c = data.worldCenter;   // fly to this layer's spot in the world
                    // Land with the floating origin already under it, so scene
                    // coords start near zero however far out the world we are.
                    const o = setWorldOriginAt({ terrain, worldGroup }, c.x, c.z);
                    const sx = c.x - o.x, sz = c.z - o.z;
                    controls.target.set(sx, 0, sz);
                    const depth = mapDepth(currentMapKey);
                    if (depth >= TACTICAL_DEPTH) {
                        camera.position.set(sx + 20, 30, sz + 20);
                        // The unified world renders at every altitude (LOD rings +
                        // ocean), so don't wall the zoom-out at tactical height —
                        // let it climb to the continent-lens ceiling.
                        controls.maxDistance = 811008;
                    } else {
                        // Hex lens: high enough that the layer's field fills the view.
                        const alt = TIER_WIDTH[depth] * 8;
                        camera.position.set(sx, alt, sz + alt * 0.3);
                        controls.maxDistance = alt * 1.6;
                    }
                }
            } else {
                // A pocket: its own separate terrain near the true origin — pin
                // the floating origin to 0 (pocket bounds assume scene == world).
                // Generator OFF: pocket ground is implicit flat 0 plus edits,
                // not the procedural world that happens to sit at the origin.
                setWorldOriginAt({ terrain, worldGroup }, 0, 0);
                controls.maxDistance = 6000;
                terrainIsUnified = false;
                terrain.generatorOn = false;
                terrain.reset();
                undoStack.length = 0; redoStack.length = 0;
                if (data.terrain) terrain.applyData(data.terrain);
                const tactical = isTacticalKey(currentMapKey);
                terrain.group.visible = tactical;
                styleGroundForTerrain(plane, tactical);
                syncWaterControls();
            }
        }

        // Instances-tab travel: we entered this map to find a token — land on it
        // (after the worldCenter landing above so the descent wins).
        // Terrain reconstruction above restores its default visibility. Reapply
        // retained storey isolation last so reconnecting in a basement cannot
        // expose terrain or vegetation until another build-panel action.
        applyBuildLevelVisibility();
        if (pendingFocus) { focusCameraOn(pendingFocus); pendingFocus = null; }
        mapReload.onMapStateApplied();
    });

    // Live terrain edits (echo to other GM tabs; players handle this too).
    socket.on('terrain-updated', (data) => {
        if (terrain) { terrain.applyData(data); syncWaterControls(); }
    });

    // Chunk deletion and water removal are one server transaction. The sender
    // stays untouched until this canonical success event arrives; other GM
    // tabs and players apply the exact same result.
    socket.on('terrain-reset-applied', (result) => applyTerrainResetResult(result));
    socket.on('terrain-reset-rejected', ({ requestId, reason } = {}) => {
        if (!pendingTerrainReset || requestId !== pendingTerrainReset.requestId) return;
        pendingTerrainReset = null;
        syncTerrainResetButton();
        alert(reason || 'The terrain reset could not be saved. Nothing was changed.');
    });

    // Live hex tag edits (global broadcast: painted biomes reshape the world).
    socket.on('hex-updated', ({ key, hex, biome }) => {
        // This layer's fills (legacy events without a key are ours too).
        if (!key || key === currentMapKey) {
            if (biome) hexTags[hex] = { biome };
            else delete hexTags[hex];
            rebuildHexFills();
        }
        // Feed the generator: update the tag tree and regrow procedural ground.
        // Regeneration (window restream + all LOD rings) is heavy, so rapid
        // paint strokes coalesce into one rebuild.
        if (key && terrain) {
            const layer = { ...(hexTree[key] || {}) };
            if (biome) layer[hex] = { biome };
            else delete layer[hex];
            hexTree = { ...hexTree, [key]: layer };
            terrain.setBiomeOverrides(hexTree);
            clearTimeout(regenTimer);
            regenTimer = setTimeout(() => terrain.regenerate(), 400);
        }
    });

    // Fog-of-war echo (our own strokes included — the mask flips here, not
    // optimistically, so every GM tab stays in lockstep with the server).
    socket.on('fog-updated', ({ hexes, revealed }) => {
        if (!Array.isArray(hexes)) return;
        for (const hk of hexes) fogMask.set(hk, revealed);
    });

    // Presence roster (View tool): who's online and where.
    socket.on('players-updated', ({ players }) => {
        playersRoster = Array.isArray(players) ? players : [];
        renderViewPlayers();
    });

    // A pocket map we requested is ready: drop its entry portal where the GM clicked.
    socket.on('pocket-created', ({ key, name }) => {
        if (!pendingPortal) return;
        socket.emit('add-object', {
            type: 'portal', target: key, name,
            position: pendingPortal.position
        });
        pendingPortal = null;
    });

    socket.on('object-added', (data) => {
        if (!objects.find(o => o.userData.syncId === data.id)) {
            createObjectFromData(data.id, data);
        }
        // Refresh the tracker's "+ add to combat" candidates.
        if (combatTracker && combatState) combatTracker.setState(combatState);
    });

    socket.on('object-moved', (data) => {
        const object = objects.find(o => o.userData.syncId === data.id);
        if (object) {
            object.position.set(data.position.x, data.position.y, data.position.z);
            updateObjectPositionData(object);
            if (selectedObject === object) renderSelectionInspector({ open: false });
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
        if (selectedObject === updated) renderSelectionInspector({ open: false });
    });

    // Atomic building/storey edits arrive as one canonical batch. The server
    // must not require clients to infer a group from positions or replay the
    // source transform independently.
    socket.on('structure-batch-applied', (result) => applyStructureBatchResult(result));
    socket.on('structure-batch-rejected', ({ requestId, reason } = {}) => {
        if (requestId) pendingStructureBatches.delete(requestId);
        setBuildBuildingStatus(reason || 'Building edit was rejected by the server.', true);
        syncBuildControls();
    });

    socket.on('object-deleted', (data) => {
        const object = objects.find(o => o.userData.syncId === data.id);
        if (object) {
            if (selectedObject === object) deselectObject();
            if (objectNameplates) objectNameplates.removeFrom(object);
            worldGroup.remove(object);
            objects = objects.filter(o => o.userData.syncId !== data.id);
            if (objectNameplates) objectNameplates.sync(objects);
            syncBuildControls();
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

    socket.on('disconnect', () => {
        mapReload.onDisconnect();
        cancelTerrainGesturesForReload();
        if (pendingTerrainReset) {
            pendingTerrainReset = null;
            syncTerrainResetButton();
        }
        clearPendingStructureBatches(
            'Connection lost during a building edit; state will reload after reconnect.', true);
        console.log('Desconectado do servidor.');
    });
}

function init() {
    workspace = createTabletopWorkspace({
        panels: {
            'object-menu': { title: 'Library', kicker: 'Create' },
            'selection-panel': { title: 'Selection', kicker: 'Selected object' },
            'terrain-panel': { title: 'Terrain', kicker: 'Author' },
            'biome-panel': { title: 'Biomes', kicker: 'World' },
            'build-panel': { title: 'Build', kicker: 'Author' },
            'fog-panel': { title: 'Fog of War', kicker: 'Visibility' },
            'view-panel': { title: 'Direct Players', kicker: 'Session' }
        },
        defaultPanel: 'object-menu',
        dockVisible: true,
        onInspectorClose: () => {
            if (selectedObject && workspace?.currentPanel() === 'selection-panel') selectionReturnContext = null;
            workspace?.setMode(currentModeLabel());
        },
        shortcuts: [
            { key: 'M', label: 'Move selected objects' },
            { key: 'R', label: 'Measure distance' },
            { key: 'L', label: 'Open the object and character library' },
            { key: 'T', label: 'Terrain or biome tools' },
            { key: 'B', label: 'Build multi-storey walls, floors, stairs and roofs' },
            { key: 'G', label: 'Paint fog of war' },
            { key: 'V', label: 'Direct player cameras' },
            { key: 'E', label: 'Show or hide the encounter dock' },
            { key: '.', label: 'Focus the selected object' },
            { key: 'Delete', label: 'Delete the selected object' },
            { key: 'Esc', label: 'Cancel the current action or selection' },
            { key: '?', label: 'Show this shortcut reference' }
        ]
    });

    ({ scene, camera, renderer, controls, plane, grid, raycaster, mouse, dirLight, worldGroup } =
        createTabletopScene(document.getElementById('scene-container')));
    objectNameplates = new ObjectNameplates();

    // Tactical terrain (heightmap + material paint + water). Hidden off-tactical.
    // The brush cursor is drawn by the terrain shader (terrain.setBrush).
    terrain = new Terrain();
    terrain.group.visible = false;
    scene.add(terrain.group);
    grass = new Grass(terrain, scene);   // ground-cover, shown only at tactical zoom
    trees = new Trees(terrain, scene);   // biome-scattered low-poly trees

    // Ramp gesture preview: a line from the anchor to the cursor while dragging.
    rampPreview = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color: 0xff9ff3, transparent: true, opacity: 0.9 })
    );
    rampPreview.visible = false;
    worldGroup.add(rampPreview); // preview points are world coords

    // River draft preview: waypoints + cursor as a light-blue polyline.
    riverPreview = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color: 0x7ad7ff, transparent: true, opacity: 0.9 })
    );
    riverPreview.visible = false;
    worldGroup.add(riverPreview); // preview points are world coords

    wasRightDrag = trackRightDrag(renderer.domElement);

    ruler = new RulerTool({
        scene: worldGroup, // ruler points/segments are world coords
        tooltip: document.getElementById('ruler-tooltip'),
        measure: (points) => isHexLayer() ? measurePath(points) : null
    });

    combatOverlays = new CombatOverlays({
        worldGroup,
        findMesh: findObjectMesh,
        feetToWorld: ft => (ft / FEET_PER_GRID_CELL) * GRID_CELL_SIZE
    });

    // Fog-of-war preview: a light version of the players' fog sheet, shown
    // while the Fog tool is active so the GM sees what is hidden from whom.
    fogOverlay = new FogOverlay(worldGroup, { opacity: 0.45, color: 0x151a24 });
    fogOverlay.setVisible(false);

    // Show the correct grid (hex vs square) for the current layer
    showLayerGrid(currentMapKey);
    updateBreadcrumb();

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    renderer.domElement.addEventListener('dblclick', onDoubleClick); // double-click a hex to descend

    // --- Menu Button Listeners (Right) ---
    menuButtons.token = document.getElementById('btn-token');
    menuButtons.cube = document.getElementById('btn-cube');
    menuButtons.sphere = document.getElementById('btn-sphere');
    menuButtons.cave = document.getElementById('btn-cave');
    menuButtons.arch = document.getElementById('btn-arch');
    menuButtons['portal-new'] = document.getElementById('btn-portal-new');
    menuButtons['portal-link'] = document.getElementById('btn-portal-link');
    menuButtons.token.addEventListener('click', () => setSelectedObjectType('token'));
    menuButtons.cube.addEventListener('click', () => setSelectedObjectType('cube'));
    menuButtons.sphere.addEventListener('click', () => setSelectedObjectType('sphere'));
    menuButtons.cave.addEventListener('click', () => setSelectedObjectType('cave'));
    menuButtons.arch.addEventListener('click', () => setSelectedObjectType('arch'));
    menuButtons['portal-new'].addEventListener('click', () => setSelectedObjectType('portal-new'));
    menuButtons['portal-link'].addEventListener('click', () => setSelectedObjectType('portal-link'));
    document.getElementById('monster-search')?.addEventListener('focus', () => { void ensureMonsterLibraryLoaded(); });
    document.getElementById('monster-search')?.addEventListener('input', () => { void ensureMonsterLibraryLoaded(); renderMonsterLibrary(); });
    document.getElementById('monster-type-filter')?.addEventListener('change', () => { void ensureMonsterLibraryLoaded(); renderMonsterLibrary(); });
    document.getElementById('monster-cr-filter')?.addEventListener('change', () => { void ensureMonsterLibraryLoaded(); renderMonsterLibrary(); });
    document.getElementById('monster-library-status')?.addEventListener('click', () => { void ensureMonsterLibraryLoaded(); });
    // Characters are loaded from the server via Socket.IO (see initSocket).

    // Characters section tabs: Spawn (place a character) | Instances (placed tokens).
    document.getElementById('char-tab-spawn').addEventListener('click', () => setCharacterTab('spawn'));
    document.getElementById('char-tab-instances').addEventListener('click', () => setCharacterTab('instances'));

    // --- Tool Menu Listeners (Left) ---
    toolMenuButtons.library = document.getElementById('btn-tool-library');
    toolMenuButtons.move = document.getElementById('btn-tool-move');
    toolMenuButtons.ruler = document.getElementById('btn-tool-ruler');
    const openLibrary = () => {
        void ensureMonsterLibraryLoaded();
        if (selectedObjectType) deselectObjectType();
        else setTool(null);
        if (workspace) workspace.showPanel('object-menu', 'Library');
    };
    toolMenuButtons.library.addEventListener('click', openLibrary);
    const topLibrary = document.getElementById('btn-workspace-library');
    if (topLibrary) topLibrary.addEventListener('click', openLibrary);
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

    // --- Terrain tool wiring ---
    toolMenuButtons.terrain = document.getElementById('btn-tool-terrain');
    toolMenuButtons.terrain.addEventListener('click', () => setTool('terrain'));
    document.querySelectorAll('#terrain-panel .brush-mode').forEach(btn => {
        btn.addEventListener('click', () => setBrushMode(btn.dataset.mode));
    });
    document.querySelectorAll('#terrain-mats .mat-swatch').forEach(btn => {
        btn.addEventListener('click', () => setBrushMaterial(+btn.dataset.mat));
    });
    const radiusInput = document.getElementById('brush-radius');
    const strengthInput = document.getElementById('brush-strength');
    radiusInput.addEventListener('input', e => setBrushRadius(+e.target.value));
    strengthInput.addEventListener('input', e => { terrainBrush.strength = +e.target.value; document.getElementById('brush-strength-val').textContent = (+e.target.value).toFixed(2); });
    document.getElementById('terrain-reset').addEventListener('click', requestTerrainReset);

    const flattenBtn = document.getElementById('flatten-target');
    if (flattenBtn) flattenBtn.addEventListener('click', clearFlattenTarget);

    // --- Build tool (tile brush) wiring ---
    toolMenuButtons.build = document.getElementById('btn-tool-build');
    toolMenuButtons.build.addEventListener('click', () => setTool('build'));
    document.getElementById('build-new-building').addEventListener('click', startNewBuilding);
    document.getElementById('build-pick-building').addEventListener('click', () => {
        setBuildingPickMode(buildBrush.buildingPickMode === 'pick' ? null : 'pick');
    });
    document.getElementById('build-adopt-structure').addEventListener('click', () => {
        setBuildingPickMode(buildBrush.buildingPickMode === 'adopt' ? null : 'adopt');
    });
    document.getElementById('build-duplicate-down').addEventListener('click', () => duplicateActiveStorey(-1));
    document.getElementById('build-duplicate-up').addEventListener('click', () => duplicateActiveStorey(1));
    document.querySelectorAll('#build-modes .brush-mode').forEach(btn => {
        btn.addEventListener('click', () => setBuildMode(btn.dataset.bmode));
    });
    document.querySelectorAll('#build-styles .brush-mode').forEach(btn => {
        btn.addEventListener('click', () => setBuildStyle(btn.dataset.bstyle));
    });
    document.getElementById('build-level-down').addEventListener('click', () => setBuildLevel(buildBrush.level - 1));
    document.getElementById('build-level-ground').addEventListener('click', () => setBuildLevel(0));
    document.getElementById('build-level-up').addEventListener('click', () => setBuildLevel(buildBrush.level + 1));
    document.getElementById('build-pick-level').addEventListener('click', () => {
        buildBrush.pickingLevel = !buildBrush.pickingLevel;
        buildBrush.buildingPickMode = null;
        buildDrag = null;
        clearBuildGhost();
        syncBuildControls();
        updateHintBar();
    });
    document.getElementById('build-level-height').addEventListener('input', e => {
        buildBrush.levelHeight = +e.target.value;
        clearBuildGhost();
        syncBuildControls();
    });
    document.getElementById('build-follow-terrain').addEventListener('change', e => {
        buildBrush.followTerrain = e.target.checked;
        clearBuildGhost();
        syncBuildControls();
    });
    document.getElementById('build-auto-snap').addEventListener('change', e => {
        buildBrush.autoSnap = e.target.checked;
    });
    document.getElementById('build-isolate-level').addEventListener('change', e => {
        buildBrush.isolate = e.target.checked;
        applyBuildLevelVisibility();
        syncBuildControls();
    });
    document.querySelectorAll('[data-stair-dir]').forEach(btn => {
        btn.addEventListener('click', () => {
            buildBrush.stairDirection = Number(btn.dataset.stairDir) < 0 ? -1 : 1;
            clearBuildGhost();
            syncBuildControls();
        });
    });
    document.querySelectorAll('[data-opening-kind]').forEach(btn => {
        btn.addEventListener('click', () => {
            buildBrush.openingKind = btn.dataset.openingKind;
            syncBuildControls();
            updateHintBar();
        });
    });
    document.querySelectorAll('[data-tile-kind]').forEach(btn => {
        btn.addEventListener('click', () => {
            buildBrush.tileKind = btn.dataset.tileKind;
            syncBuildControls();
            updateHintBar();
        });
    });
    document.querySelectorAll('[data-roof-shape]').forEach(btn => {
        btn.addEventListener('click', () => {
            buildBrush.roofShape = btn.dataset.roofShape;
            clearBuildGhost();
            syncBuildControls();
            updateHintBar();
        });
    });
    document.getElementById('build-roof-pitch').addEventListener('input', e => {
        buildBrush.roofPitch = +e.target.value;
        clearBuildGhost();
        syncBuildControls();
    });
    document.getElementById('wall-height').addEventListener('input', e => {
        buildBrush.wallHeight = +e.target.value;
        document.getElementById('wall-height-val').textContent = (+e.target.value).toFixed(1);
        clearBuildGhost();
    });
    document.getElementById('build-scruffy').addEventListener('change', e => {
        buildBrush.scruffy = e.target.checked;
        clearBuildGhost();
    });
    syncBuildControls();

    // --- Fog of war tool wiring ---
    toolMenuButtons.fog = document.getElementById('btn-tool-fog');
    toolMenuButtons.fog.addEventListener('click', () => setTool('fog'));
    document.querySelectorAll('#fog-modes .brush-mode').forEach(btn => {
        btn.addEventListener('click', () => setFogMode(btn.dataset.fmode));
    });
    document.getElementById('fog-radius').addEventListener('input', e => {
        fogBrush.radius = +e.target.value;
        document.getElementById('fog-radius-val').textContent = e.target.value;
    });

    // --- View tool (steer player cameras) wiring ---
    toolMenuButtons.view = document.getElementById('btn-tool-view');
    toolMenuButtons.view.addEventListener('click', () => setTool('view'));
    document.querySelectorAll('#view-actions .brush-mode').forEach(btn => {
        btn.addEventListener('click', () => setViewAction(btn.dataset.vaction));
    });
    document.getElementById('view-fly').addEventListener('change', e => { viewCtl.fly = e.target.checked; });
    document.getElementById('view-lock').addEventListener('change', e => { viewCtl.lock = e.target.checked; });
    document.getElementById('view-bring').addEventListener('click', () => {
        emitViewCommand(viewPoseFromHere(), 'My view', true);
    });
    document.getElementById('view-release').addEventListener('click', () => {
        if (!socket) return;
        socket.emit('camera-release', { target: viewCtl.target });
        setViewStatus(`Released ${viewCtl.target === 'all' ? 'all players' : viewCtl.target}`);
    });
    renderViewPlayers(); // empty-roster placeholder until players-updated lands

    // Biome palette (hex layers).
    document.querySelectorAll('#biome-panel .biome-swatch').forEach(btn => {
        btn.addEventListener('click', () => setBiome(btn.dataset.biome));
    });

    const upBtn = document.getElementById('btn-up');
    if (upBtn) upBtn.addEventListener('click', goUp);
    updateHintBar();

    dismissSubmenusOnOutsideClick([
        [moveSubMenu, toolMenuButtons.move],
        [rulerSubMenu, toolMenuButtons.ruler]
    ]);

    startRenderLoop({
        renderer, scene, camera, controls,
        onTick: () => {
            updateWorldFollow({ plane, grid, dirLight, camera }, controls.target); // ground/shadows follow
            if (combatOverlays) combatOverlays.tick(); // rings/badges track their tokens
            tickRigCharacters();                                           // character idle/walk clips
            if (!terrain) return;
            terrain.tick(performance.now() / 1000);                       // water animation
            if (terrain.group.visible) updateTerrainLOD();                 // detailed chunks vs summary
        }
    });
    // Debug handle for console/tooling inspection (visual bisection etc).
    // forceRender draws one frame even while the tab is hidden (rAF paused).
    window.__dbg = {
        terrain, scene, camera, controls, plane, grid, renderer, worldGroup, fogMask,
        forceRender: () => { updateTerrainLOD(); renderer.render(scene, camera); }
    };
    initSocket();
    window.__dbg.socket = socket; // headless testing: emit/inspect sync events
}

function onPointerDown(event) {
    // The left button belongs to tools; right/middle belong to the camera (OrbitControls).
    if (event.button !== 0) return;
    // Socket.IO buffers emits while disconnected. Do not let an interaction
    // started before the authenticated reload queue a stale authoring intent.
    if (!socket?.connected || !mapReload.authenticated) return;

    if (isDraggingHeight) {
        isDraggingHeight = false;
        if (selectedObject?.userData.syncId && socket) {
            const position = { x: selectedObject.position.x, y: selectedObject.position.y, z: selectedObject.position.z };
            updateObjectPositionData(selectedObject);
            socket.emit('move-object', { id: selectedObject.userData.syncId, position });
        }
        deselectObject();
        return;
    }

    // Terrain tool on a hex layer = biome painting (Alt+click clears the tag).
    if (currentTool === 'terrain' && isHexLayer()) {
        castFromPointer(event, { renderer, camera, raycaster, mouse });
        const hit = raycaster.intersectObject(plane)[0];
        if (!hit) return;
        const p = sceneToWorld(hit.point);
        const h = worldToHex(p.x, p.z);
        if (!hexInField(h.q, h.r)) return;
        socket.emit('update-hex', { q: h.q, r: h.r, biome: event.altKey ? null : currentBiome });
        return;
    }

    // Fog tool: drag-paint reveal/hide on the global fog lattice.
    if (fogActive()) {
        fogStroke = new Set();
        paintFogAt(event);
        return;
    }

    // View tool: a click steers the selected players' cameras there.
    if (viewActive()) {
        if (viewCtl.action === 'token') {
            const t = pickSceneObject(event);
            if (!t) { setViewStatus('No token under the cursor'); return; }
            const name = (t.userData.characterData && t.userData.characterData.name) ||
                         t.userData.objectType || 'object';
            emitViewCommand(viewPoseAt(t.position), `Token "${name}"`);
        } else {
            const p = pointerToGround(event);
            if (p) emitViewCommand(viewPoseAt(p), 'Point');
        }
        return;
    }

    // Build tool (tile brush): draw structures or edit individual cells.
    if (buildActive()) {
        if (pendingStructureBatches.size) {
            setBuildBuildingStatus('Wait for the current building edit to finish.', true);
            return;
        }
        if (buildBrush.buildingPickMode) {
            handleBuildingPick(event);
            return;
        }
        if (buildBrush.pickingLevel) {
            adoptBuildLevelAt(event);
            return;
        }
        if (buildBrush.mode === 'erase' || buildBrush.mode === 'opening' ||
            buildBrush.mode === 'tile' || event.altKey) {
            const targetTypes = event.altKey || buildBrush.mode === 'erase' ? null
                : buildBrush.mode === 'opening' ? new Set(['wall'])
                    : new Set(['floor', 'roof']);
            const hit = pickBuildHit(event, targetTypes);
            if (!hit) return;
            const type = hit.object.userData.objectType;
            if (event.altKey) {
                socket.emit('delete-object', { id: hit.object.userData.syncId });
            } else if (type === 'wall' && hit.segmentIndex != null &&
                (buildBrush.mode === 'erase' || buildBrush.mode === 'opening')) {
                updateWallSegment(hit.object, hit.segmentIndex,
                    buildBrush.mode === 'erase' ? 'gap' : buildBrush.openingKind);
            } else if ((type === 'floor' || type === 'roof') && hit.tileIndex != null &&
                (buildBrush.mode === 'erase' || buildBrush.mode === 'tile')) {
                updateStructureTile(hit.object, hit.tileIndex,
                    buildBrush.mode === 'erase' ? 'gap' : buildBrush.tileKind);
            } else if (buildBrush.mode === 'erase') {
                socket.emit('delete-object', { id: hit.object.userData.syncId });
            }
            return;
        }
        // Walls, stairs and covers started over a floor inherit that floor's
        // level, so the common "floor first" workflow needs no manual dial.
        if (buildBrush.autoSnap && buildBrush.mode !== 'floor') {
            adoptBuildLevelAt(event, { structuresOnly: true, quiet: true });
        }
        let p = pointerToBuildSurface(event);
        if (!p) return;
        const seed = Math.floor(Math.random() * 1e9);
        const placement = buildBrush.mode === 'roof'
            ? resolveRoofPlacement(p)
            : resolveBuildPlacement(p);
        if (placement.heightMode === 'flat') p = pointerToBuildSurface(event) || p;
        const authoredIdentity = {
            buildingId: buildBrush.buildingId,
            structureId: newStructureIdentity('structure'),
            buildingDatumY: placement.buildingDatumY
        };
        if (buildBrush.mode === 'wall') {
            const c = snapCorner(p);
            buildDrag = {
                kind: 'wall', ax: c.x, az: c.z, wallAxis: null,
                wallCorners: [{ x: c.x, z: c.z }], seed, ...placement, ...authoredIdentity
            };
        } else if (buildBrush.mode === 'stair') {
            buildDrag = {
                kind: 'stair', ax: Math.floor(p.x / GRID_CELL_SIZE), az: Math.floor(p.z / GRID_CELL_SIZE),
                seed, ...placement, ...authoredIdentity
            };
        } else if (buildBrush.mode === 'roof') {
            buildDrag = {
                kind: 'roof', ax: Math.floor(p.x / GRID_CELL_SIZE), az: Math.floor(p.z / GRID_CELL_SIZE),
                seed, ...placement, ...authoredIdentity
            };
        } else {
            buildDrag = {
                kind: 'floor', ax: Math.floor(p.x / GRID_CELL_SIZE), az: Math.floor(p.z / GRID_CELL_SIZE),
                seed, ...placement, ...authoredIdentity
            };
        }
        updateBuildGhost(p);
        return;
    }

    if (terrainActive()) {
        const p = pointerToGround(event);
        if (!p) return;
        if (terrainBrush.mode === 'lake') {
            beginLakeGesture(p, event);
            return;
        }
        if (terrainBrush.mode === 'river') {
            if (event.altKey) {
                const r = terrain.findRiverAt(p.x, p.z);
                if (r) {
                    const before = terrain.getWaterData().bodies;
                    terrain.removeBody(r.id);
                    pushWaterUndo(before);
                    emitWater();
                }
                return;
            }
            if (!riverDraft) riverDraft = { points: [] };
            riverDraft.points.push({ x: p.x, z: p.z });
            updateRiverPreview(p);
            return;
        }
        // Alt+click: eyedropper. Samples the height as the flatten target
        // (and the dominant material when painting) instead of stroking.
        if (event.altKey) {
            sampleUnderCursor(p);
            return;
        }
        if (terrainBrush.mode === 'ramp') {
            rampStart = { x: p.x, z: p.z, h: terrain.sampleHeight(p.x, p.z) };
            updateRampPreview(p);
            return;
        }
        // Sculpt/paint: start a stroke (copy-on-write undo opens with it).
        terrain.beginStroke();
        isSculpting = true;
        strokeRef = terrainBrush.flattenRef != null ? terrainBrush.flattenRef : terrain.sampleHeight(p.x, p.z);
        lastDab = null;
        terrainDab(p);
        terrain.flushMeshes();
        updateBrushCursor(p);
        return;
    }

    castFromPointer(event, { renderer, camera, raycaster, mouse });
    const allObjects = [...(buildCutawayState ? [] : [plane]), ...objects.filter(o => o.visible)];
    const intersects = raycaster.intersectObjects(allObjects, true);
    if (intersects.length === 0) return;

    const firstIntersect = intersects[0];
    let topLevelObject = firstIntersect.object;
    while (topLevelObject.parent && topLevelObject.parent !== scene && topLevelObject.parent !== worldGroup) {
        topLevelObject = topLevelObject.parent;
    }
    const clickedObject = objects.find(obj => obj === topLevelObject);

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
        updateHintBar();
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
        updateHintBar();
        return;
    }

    // Build surfaces usually read as GROUND for the placement tools — you drop
    // tokens ON a floor, measure across a room, release a move onto it. The
    // move tool can still grab one when nothing else is selected (to reposition
    // a whole run/patch or Del-delete it); the build tool's erase removes them.
    const clickedType = clickedObject && clickedObject.userData.objectType;
    const buildAsGround = isStructureType(clickedType) &&
        (currentTool === 'add' || currentTool === 'ruler' ||
         (currentTool === 'move' && selectedObject && selectedObject !== clickedObject));

    if (clickedObject && !buildAsGround) {
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
        const support = (buildAsGround || ['move', 'add', 'ruler'].includes(currentTool))
            ? pickSupportSurface(event, { exclude: selectedObject }) : null;
        const intersectPoint = support ? support.point : sceneToWorld(firstIntersect.point);
        const snappedPosition = snapToCurrentGrid(intersectPoint);

        switch (currentTool) {
            case 'move':
                if (selectedObject) {
                    const docId = selectedObject.userData.syncId;
                    if (docId) {
                        if (support) selectedObject.position.y = support.point.y + (selectedObject.userData.halfHeight || 0);
                        const finalPosition = snapToCurrentGrid(selectedObject.position);
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
                }
                break;
            case 'add':
                if (selectedObjectType) {
                    addObject(snappedPosition, support && support.object ? support.point.y : null);
                    focusCameraOn(snappedPosition);
                    deselectObjectType();
                }
                break;
            case 'ruler':
                ruler.click(getCurrentRulerSnap(intersectPoint), emitRuler);
                break;
            default:
                if (selectedObject) deselectObject();
                break;
        }
    }
}

function onPointerMove(event) {
    ruler.trackMouse(event);

    // Fog tool: keep painting along the drag.
    if (fogStroke && fogActive()) {
        paintFogAt(event);
        return;
    }

    // Terrain tool: stroke along the drag (fixed-spacing dabs so intensity doesn't
    // depend on mouse speed), or just move the brush cursor while hovering.
    if (terrainActive()) {
        // Lake level drag: vertical mouse motion, independent of the ground pick.
        if (lakeDrag) {
            const level = lakeDrag.startLevel + (lakeDrag.startClientY - event.clientY) * 0.05;
            terrain.updateLake(lakeDrag.id, { level });
            return;
        }
        const p = pointerToGround(event);
        if (p) {
            if (isSculpting) { strokeTo(p); terrain.flushMeshes(); }
            if (rampStart) updateRampPreview(p);
            if (riverDraft && riverDraft.points.length) updateRiverPreview(p);
            updateBrushCursor(p);
        }
        if (isSculpting || rampStart) return;
    }

    // Build tool: ghost preview follows the cursor (hover marker or live drag).
    if (buildActive()) {
        if (pendingStructureBatches.size) {
            clearBuildGhost();
            return;
        }
        const p = pointerToBuildSurface(event);
        if (p) updateBuildGhost(p);
        return;
    }

    if (isDraggingHeight && selectedObject) {
        const deltaY = event.movementY * -0.01;
        selectedObject.position.y += deltaY;
        const halfHeight = selectedObject.userData.halfHeight || 0;
        if (selectedObject.position.y < halfHeight) {
            selectedObject.position.y = halfHeight;
        }
        return;
    }

    if (currentTool !== 'move' && currentTool !== 'ruler') return;
    const support = pickSupportSurface(event, { exclude: selectedObject });
    if (!support) return;
    const intersectPoint = support.point;

    if (currentTool === 'move' && selectedObject) {
        applyMove(selectedObject, snapToCurrentGrid(intersectPoint), currentMoveMode,
            (x, z, halfHeight) => intersectPoint.y + halfHeight);
        updateMoveCostTooltip(event); // combat: live «X ft — Y ft left»
    }

    if (currentTool === 'ruler' && ruler.points.length > 0) {
        const previewPoints = [...ruler.points, getCurrentRulerSnap(intersectPoint)];
        ruler.updatePreview(previewPoints);
        ruler.updateTooltip(previewPoints, false);
    } else if (currentTool === 'ruler') {
        ruler.updateTooltip([], false, true); // show "0" at the cursor
    }
}

function onPointerUp(event) {
    if (event.button !== 0) return;

    // Fog stroke ends with the drag.
    if (fogStroke) { fogStroke = null; return; }

    // Build drag: commit the wall run, floor/roof rectangle or staircase.
    if (buildDrag) {
        const p = pointerToBuildSurface(event);
        if (p) commitBuildDrag(p);
        buildDrag = null;
        clearBuildGhost();
        return;
    }

    // Lake gesture: commit the poured/re-leveled lake.
    if (lakeDrag) {
        pushWaterUndo(lakeDrag.before);
        emitWater();
        lakeDrag = null;
        return;
    }

    // Ramp gesture: apply on release.
    if (rampStart) {
        const p = pointerToGround(event);
        rampPreview.visible = false;
        if (p && Math.hypot(p.x - rampStart.x, p.z - rampStart.z) > 0.5) {
            terrain.beginStroke();
            terrain.ramp(rampStart.x, rampStart.z, rampStart.h,
                p.x, p.z, terrain.sampleHeight(p.x, p.z),
                terrainBrush.radius, 1);
            finishTerrainStroke();
        }
        rampStart = null;
        return;
    }

    // End a terrain stroke: close the undo patch, sync only the dirty chunks.
    if (isSculpting) {
        isSculpting = false;
        lastDab = null;
        finishTerrainStroke();
    }
}

// Close the open stroke: record its undo patch and emit the dirty chunks.
function finishTerrainStroke() {
    const patch = terrain.endStroke();
    if (patch) {
        undoStack.push({ kind: 'chunks', patch });
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
        redoStack.length = 0;
    }
    const payload = terrain.collectDirtyPayload();
    if (payload) {
        if (payload.heightsChanged) terrain.refreshWater(); // lakes re-settle into the new shape
        if (socket) socket.emit('update-terrain', { chunks: payload.chunks });
    }
}

// --- Lake gesture (water v2): pour / re-level / delete ---
function beginLakeGesture(p, event) {
    const before = terrain.getWaterData().bodies;
    const existing = terrain.findLakeAt(p.x, p.z);
    if (event.altKey) {
        if (existing) {
            terrain.removeBody(existing.id);
            pushWaterUndo(before);
            emitWater();
        }
        return;
    }
    let id, startLevel;
    if (existing) {
        id = existing.id;
        startLevel = existing.level;
    } else {
        const body = terrain.addLake({ x: p.x, z: p.z, level: terrain.sampleHeight(p.x, p.z) + 1 });
        id = body.id;
        startLevel = body.level;
    }
    lakeDrag = { id, startLevel, startClientY: event.clientY, before };
}
function pushWaterUndo(beforeBodies) {
    undoStack.push({ kind: 'water', before: beforeBodies, after: terrain.getWaterData().bodies });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
}

// --- River draft (water v2 W2): click waypoints, Enter/double-click commits ---
function updateRiverPreview(cursor) {
    if (!riverDraft || !riverDraft.points.length) return;
    const pts = [...riverDraft.points, cursor].map(p =>
        new THREE.Vector3(p.x, terrain.sampleHeight(p.x, p.z) + 0.15, p.z));
    riverPreview.geometry.setFromPoints(pts);
    riverPreview.visible = true;
}
function cancelRiverDraft() {
    riverDraft = null;
    if (riverPreview) riverPreview.visible = false;
}

// A disconnect can strand a copy-on-write stroke or water gesture after local
// mutation but before its server emit. Discard that transient transaction so
// the authenticated reconnect snapshot cannot be captured into stale undo and
// later resurrect data the server has already removed.
function cancelTerrainGesturesForReload() {
    isSculpting = false;
    lastDab = null;
    strokeRef = 0;
    rampStart = null;
    if (rampPreview) rampPreview.visible = false;
    if (terrain && lakeDrag) terrain.setWaterData({ bodies: lakeDrag.before });
    lakeDrag = null;
    cancelRiverDraft();
    buildDrag = null;
    clearBuildGhost();
    fogStroke = null;
    isDraggingHeight = false;
    undoStack.length = 0;
    redoStack.length = 0;
    if (ruler) ruler.clearInProgress();
    if (terrain) {
        terrain.cancelStroke();
        terrain.setBrush({ visible: false });
    }
}
function commitRiver() {
    if (!riverDraft) return;
    // Drop duplicate clicks (a committing double-click adds two nearby points).
    const pts = [];
    for (const p of riverDraft.points) {
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(p.x - last.x, p.z - last.z) > 0.6) pts.push(p);
    }
    cancelRiverDraft();
    if (pts.length < 2) return;
    const width = Math.max(1, Math.min(12, terrainBrush.radius * 0.5));
    const before = terrain.getWaterData().bodies;
    // Carve the bed first (normal undoable+synced chunk edits), then drape the river.
    const carveBox = document.getElementById('river-carve');
    if (!carveBox || carveBox.checked) {
        terrain.beginStroke();
        terrain.carveRiverBed(pts, width / 2 + 0.5, 0.6);
        terrain.flushMeshes();
        const patch = terrain.endStroke();
        if (patch) {
            undoStack.push({ kind: 'chunks', patch });
            while (undoStack.length > UNDO_LIMIT) undoStack.shift();
            redoStack.length = 0;
        }
        const payload = terrain.collectDirtyPayload();
        if (payload && socket) socket.emit('update-terrain', { chunks: payload.chunks });
    }
    terrain.addRiver({ points: pts, width, speed: 1 });
    terrain.refreshWater(); // carve may have re-settled lakes too
    pushWaterUndo(before);
    emitWater();
}

function onContextMenu(event) {
    event.preventDefault();
    if (wasRightDrag && wasRightDrag(event)) return; // right-drag = camera orbit, not a click
    if (currentTool !== 'ruler') return;
    const support = pickSupportSurface(event);
    if (support) ruler.restartAt(getCurrentRulerSnap(support.point), emitRuler);
}

const BRUSH_MODE_KEYS = { '1': 'raise', '2': 'lower', '3': 'smooth', '4': 'flatten', '5': 'noise', '6': 'terrace', '7': 'ramp', '8': 'paint', '9': 'lake', '0': 'river' };

function onKeyDown(event) {
    if (event.key === 'Shift') shiftDown = true;
    // Don't steal keys while the user types in an input/slider.
    const tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    // Undo/redo terrain strokes (Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y).
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (!socket?.connected || !mapReload.authenticated) return;
        event.shiftKey ? redoTerrain() : undoTerrain();
        return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        if (!socket?.connected || !mapReload.authenticated) return;
        redoTerrain();
        return;
    }

    // Workspace shortcuts stay single-key and map-focused. Text inputs were
    // excluded above, and modified browser/OS shortcuts pass through untouched.
    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat) {
        const key = event.key.toLowerCase();
        if (key === 'm') { event.preventDefault(); setMoveMode('standard'); return; }
        if (key === 'r') { event.preventDefault(); setRulerMode(ruler.mode); return; }
        if (key === 'l') {
            event.preventDefault();
            if (selectedObjectType) deselectObjectType(); else setTool(null);
            workspace?.showPanel('object-menu', 'Library', 'Create');
            return;
        }
        if (key === 't') { event.preventDefault(); setTool('terrain'); return; }
        if (key === 'b') { event.preventDefault(); setTool('build'); return; }
        if (key === 'g') { event.preventDefault(); setTool('fog'); return; }
        if (key === 'v') { event.preventDefault(); setTool('view'); return; }
        if (key === 'e') { event.preventDefault(); workspace?.toggleDock(); return; }
        if (event.key === '.' && selectedObject) { event.preventDefault(); frameCameraOn(selectedObject.position); return; }
    }

    // Terrain hotkeys: [ ] brush size, 1-8 brush modes.
    if (terrainActive()) {
        if (event.key === '[') { setBrushRadius(terrainBrush.radius - 1); return; }
        if (event.key === ']') { setBrushRadius(terrainBrush.radius + 1); return; }
        const mode = BRUSH_MODE_KEYS[event.key];
        if (mode) { setBrushMode(mode); return; }
    }

    if (buildActive()) {
        if (event.key === 'PageUp') { event.preventDefault(); setBuildLevel(buildBrush.level + 1); return; }
        if (event.key === 'PageDown') { event.preventDefault(); setBuildLevel(buildBrush.level - 1); return; }
        if (event.key === 'Home') { event.preventDefault(); setBuildLevel(0); return; }
    }

    if ((event.key === "Delete" || event.key === "Backspace") && selectedObject) {
        const docId = selectedObject.userData.syncId;
        if (docId) {
            socket.emit('delete-object', { id: docId });
            deselectObject();
        }
    }
    if (event.key === "Enter" && riverDraft && riverDraft.points.length >= 2) {
        commitRiver();
        return;
    }
    if (event.key === "Escape") {
        if (pendingAttack) {
            pendingAttack = null;
            if (combatTracker) combatTracker.flash('Attack cancelled');
            updateHintBar();
        } else if (pendingSpell) {
            pendingSpell = null;
            if (combatTracker) combatTracker.flash('Spell cancelled');
            updateHintBar();
        } else if (buildBrush.buildingPickMode) {
            setBuildingPickMode(null);
        } else if (buildBrush.pickingLevel) {
            buildBrush.pickingLevel = false;
            syncBuildControls();
            updateHintBar();
        } else if (buildDrag) {
            buildDrag = null;
            clearBuildGhost();
        } else if (riverDraft) {
            cancelRiverDraft();
        } else if (lakeDrag) {
            terrain.setWaterData({ bodies: lakeDrag.before }); // cancel: restore pre-gesture
            lakeDrag = null;
        } else if (rampStart) {
            rampStart = null;
            rampPreview.visible = false;
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

function onKeyUp(event) {
    if (event.key === 'Shift') shiftDown = false;
}

// --- Object Management ---

// Emit a new object to the server; the 'object-added' echo builds the mesh.
function addObject(position, supportY = null) {
    let halfHeight = 0.5;
    let dataToSave = {};

    switch (selectedObjectType) {
        case 'token':
            halfHeight = 0.1;
            dataToSave = { type: 'token', color: 0xdd4444 };
            break;
        case 'monster': {
            const monsterData = monsterTokenSnapshot(selectedObjectData);
            if (!monsterData) return;
            halfHeight = 0.1;
            dataToSave = {
                type: 'token',
                name: monsterData.name,
                color: monsterColor(monsterData),
                monsterData
            };
            break;
        }
        case 'cube':
            halfHeight = GRID_CELL_SIZE * 0.4;
            dataToSave = { type: 'cube', color: 0xdd4444 };
            break;
        case 'sphere':
            halfHeight = GRID_CELL_SIZE * 0.4;
            dataToSave = { type: 'sphere', color: 0xdd4444 };
            break;
        case 'character':
            if (selectedObjectData) {
                const heightScale = selectedObjectData.appearance.height || 1;
                halfHeight = (1 * heightScale) / 2 * 0.4;
                dataToSave = { type: 'character', characterData: selectedObjectData };
            } else {
                return;
            }
            break;
        case 'cave':
            halfHeight = 0;
            dataToSave = { type: 'cave' };
            break;
        case 'arch':
            halfHeight = 0;
            dataToSave = { type: 'arch' };
            break;
        case 'portal-new': {
            // Create a pocket dungeon; its entry portal lands where the GM clicked
            // once the server replies with the new map key ('pocket-created').
            const name = prompt('Dungeon/room name?', 'New Dungeon');
            if (!name) return;
            const sizeStr = prompt('Size in cells (width x height)?', '24x24') || '24x24';
            const m = sizeStr.match(/(\d+)\s*[xX×]\s*(\d+)/);
            const width = m ? +m[1] : 24, height = m ? +m[2] : 24;
            pendingPortal = {
                position: { x: position.x, y: groundY(position.x, position.z, 0, supportY), z: position.z }
            };
            socket.emit('create-pocket-map', { name, width, height, parentKey: currentMapKey });
            return;
        }
        case 'portal-link': {
            // Link to any existing map by key (hex-tree or pocket).
            const target = prompt('Target map key (e.g. world/0,0/0,0 or pocket/ab12cd34)?', 'world');
            if (!target || !target.trim()) return;
            halfHeight = 0;
            dataToSave = { type: 'portal', target: target.trim(), name: target.trim() };
            break;
        }
        default:
            return;
    }

    // The clicked surface wins: elevated/basement floors are real supports, not
    // just scenery. Calls without a surface still fall back to terrain.
    dataToSave.position = { x: position.x, y: groundY(position.x, position.z, halfHeight, supportY), z: position.z };
    socket.emit('add-object', dataToSave);
}

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
    applyBuildLevelVisibility();
    return replacement;
}

function createObjectFromData(id, data) {
    const mesh = buildObjectFromData(id, data);
    if (mesh) {
        worldGroup.add(mesh); // synced positions are world coords
        objects.push(mesh);
        applyBuildLevelVisibility();
        if (objectNameplates) objectNameplates.sync(objects);
        syncBuildControls();
    }
}

const INSPECTOR_CONDITIONS = ['prone', 'poisoned', 'restrained', 'stunned', 'blinded', 'frightened', 'grappled', 'invisible', 'down'];

function currentModeLabel() {
    return ({ add: 'Place', move: 'Move', ruler: 'Measure', terrain: 'Terrain', build: 'Build', fog: 'Fog', view: 'Direct' })[currentTool] || 'Explore';
}

function selectedTypeLabel(type) {
    return ({
        character: 'Character token', token: 'Creature token', cube: 'Object', sphere: 'Object',
        cave: 'Cave prop', arch: 'Rock arch', portal: 'Portal', wall: 'Wall run',
        floor: 'Floor patch', stair: 'Staircase', roof: 'Roof / ceiling'
    })[type] || 'Scene object';
}

function fmtCoord(value) {
    const n = Number(value) || 0;
    return Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2).replace(/\.00$/, '');
}

function metric(label, value) {
    return `<div class="selection-metric"><span>${escHtml(label)}</span><strong>${escHtml(value)}</strong></div>`;
}

function derivedSelectionStats(char) {
    if (!char || !SRD) return null;
    try { return deriveCombatStats(char, SRD); }
    catch (error) { return null; }
}

function renderSelectionInspector({ open = true } = {}) {
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
    const derived = char ? derivedSelectionStats(char) : (monster ? monsterCombatStats(monster) : null);
    const stats = combatant || derived;
    const hpCurrent = combatant?.hp?.current ?? char?.hp?.current ?? stats?.maxHP ?? '—';
    const hpMax = combatant?.maxHP ?? stats?.maxHP ?? '—';
    const owner = char?.owner || data.owner || '';
    const ownerLabel = /^gm$/i.test(owner) ? 'GM' : owner;
    const classes = (char?.classes || []).map(entry => `${entry.class || 'class'} ${entry.level || 1}`).join(' / ');
    const monsterMeta = monster
        ? `${monster.size || 'Medium'} ${monster.type || 'creature'} · CR ${monsterChallengeLabel(monster.challenge_rating)} · ${monster.custom ? 'Custom' : 'SRD 5.1'}`
        : '';
    const meta = [selectedTypeLabel(type), identity.instanceText, owner ? `Owned by ${ownerLabel}` : '', char?.race || '', classes, monsterMeta]
        .filter(Boolean).join(' · ');

    let statsHTML = '';
    if (type === 'character' || type === 'token') {
        statsHTML = `<div class="selection-section">
            <div class="selection-section-title"><span>At a glance</span>${combatant ? '<span>In encounter</span>' : ''}</div>
            <div class="selection-metrics">
                ${metric('HP', `${hpCurrent}/${hpMax}`)}
                ${metric('AC', stats?.ac ?? '—')}
                ${metric('Speed', stats?.speedFeet != null ? `${stats.speedFeet} ft` : '—')}
                ${metric('Initiative', combatant?.initiative ?? (stats?.initMod != null ? `${stats.initMod >= 0 ? '+' : ''}${stats.initMod}` : '—'))}
                ${metric('Conditions', combatant?.effects?.length || 0)}
                ${metric('Turn', combatant && combatState.started ? (combatState.activeId === id ? 'Active' : 'Waiting') : '—')}
            </div>
        </div>`;
    }

    const canEditAppearance = ['token', 'cube', 'sphere', 'portal'].includes(type);
    const canEditColor = ['token', 'cube', 'sphere'].includes(type);
    const detailsHTML = canEditAppearance ? `<div class="selection-section">
        <div class="selection-section-title"><span>Identity</span><span>Shared live</span></div>
        <form id="selection-details-form" class="selection-form selection-form-details">
            <label class="selection-field">Name<input name="name" maxlength="40" value="${escHtml(data.name || identity.name)}"></label>
            ${canEditColor ? `<label class="selection-field">Color<input name="color" type="color" value="${escHtml(identity.color)}"></label>` : ''}
            <button class="selection-button primary wide" type="submit">Save details</button>
        </form>
    </div>` : '';

    let combatHTML = '';
    if (type === 'character' || type === 'token') {
        if (combatant) {
            const effects = new Set((combatant.effects || []).map(effect => effect.key));
            combatHTML = `<div class="selection-section">
                <div class="selection-section-title"><span>Encounter stats</span><span>${combatState.started && combatState.activeId === id ? `${remainingFeet(combatant)} ft left` : `Round ${combatState.round == null ? '—' : combatInteger(combatState.round, { fallback: 0, min: 0, max: 1000000 })}`}</span></div>
                <form id="selection-combat-form" class="selection-form">
                    <label class="selection-field">Current HP<input name="hpCurrent" type="number" min="0" max="999" value="${escHtml(combatant.hp?.current ?? combatant.maxHP)}"></label>
                    <label class="selection-field">Max HP<input name="maxHP" type="number" min="1" max="999" value="${escHtml(combatant.maxHP)}"></label>
                    <label class="selection-field">AC<input name="ac" type="number" min="1" max="30" value="${escHtml(combatant.ac)}"></label>
                    <label class="selection-field">Speed<input name="speedFeet" type="number" min="0" max="120" value="${escHtml(combatant.speedFeet)}"></label>
                    <label class="selection-field">Initiative<input name="initiative" type="number" min="-20" max="60" value="${combatant.initiative == null ? '' : escHtml(combatant.initiative)}"></label>
                    <button class="selection-button primary" type="submit">Update stats</button>
                </form>
                <div class="selection-section-title" style="margin-top:11px"><span>Conditions</span><span>Click to toggle</span></div>
                <div class="selection-effects">
                    ${INSPECTOR_CONDITIONS.map(key => `<button type="button" class="selection-effect${effects.has(key) ? ' active' : ''}" data-condition="${key}">${escHtml(EFFECTS[key]?.label || key)}</button>`).join('')}
                </div>
                <div class="selection-actions"><button type="button" class="selection-button danger wide" data-selection-act="combat-remove">Remove from encounter</button></div>
            </div>`;
        } else if (combatState) {
            combatHTML = `<div class="selection-section"><div class="selection-section-title"><span>Encounter</span></div>
                <button type="button" class="selection-button primary" data-selection-act="combat-add">Add to encounter</button></div>`;
        } else {
            combatHTML = `<div class="selection-section"><div class="selection-section-title"><span>Encounter</span></div>
                <button type="button" class="selection-button primary" data-selection-act="combat-start">Start encounter with map tokens</button></div>`;
        }
    }

    content.innerHTML = `<div class="selection-hero" style="--selection-color:${escHtml(identity.color)}">
            <span class="selection-color"></span>
            <div><span class="selection-name">${escHtml(identity.displayName)}</span><span class="selection-meta">${escHtml(meta)}</span></div>
        </div>
        ${statsHTML}
        ${monsterStatBlockHTML(monster)}
        ${detailsHTML}
        <div class="selection-section">
            <div class="selection-section-title"><span>Position</span><span>World coordinates</span></div>
            <form id="selection-position-form" class="selection-form">
                <label class="selection-field">X<input name="x" type="number" step="0.01" value="${fmtCoord(object.position.x)}"></label>
                <label class="selection-field">Y<input name="y" type="number" step="0.01" value="${fmtCoord(object.position.y)}"></label>
                <label class="selection-field">Z<input name="z" type="number" step="0.01" value="${fmtCoord(object.position.z)}"></label>
                <button class="selection-button primary wide" type="submit">Move to coordinates</button>
            </form>
        </div>
        <div class="selection-section">
            <div class="selection-section-title"><span>Map actions</span></div>
            <div class="selection-actions">
                <button type="button" class="selection-button primary" data-selection-act="move">Move on map</button>
                <button type="button" class="selection-button" data-selection-act="focus">Focus camera</button>
                <button type="button" class="selection-button" data-selection-act="duplicate">Duplicate</button>
                ${char ? '<button type="button" class="selection-button" data-selection-act="instances">All instances</button>' : ''}
                ${char?.id ? '<button type="button" class="selection-button wide" data-selection-act="studio">Open character in Studio</button>' : ''}
                <button type="button" class="selection-button danger wide" data-selection-act="delete">Delete from map</button>
            </div>
        </div>
        ${combatHTML}`;

    content.querySelector('#selection-details-form')?.addEventListener('submit', event => {
        event.preventDefault();
        if (!socket || selectedObject !== object) return;
        const form = new FormData(event.currentTarget);
        const patch = { name: String(form.get('name') || '').trim() };
        if (form.has('color')) patch.color = form.get('color');
        socket.emit('update-object', { id, patch });
    });

    content.querySelector('#selection-position-form')?.addEventListener('submit', event => {
        event.preventDefault();
        if (!socket || selectedObject !== object) return;
        const form = new FormData(event.currentTarget);
        const position = { x: Number(form.get('x')), y: Number(form.get('y')), z: Number(form.get('z')) };
        if (!Object.values(position).every(Number.isFinite)) return;
        object.position.set(position.x, position.y, position.z);
        updateObjectPositionData(object);
        socket.emit('move-object', { id, position });
        renderSelectionInspector({ open: false });
    });

    content.querySelector('#selection-combat-form')?.addEventListener('submit', event => {
        event.preventDefault();
        if (!socket || selectedObject !== object) return;
        const form = new FormData(event.currentTarget);
        const patch = {};
        for (const key of ['hpCurrent', 'maxHP', 'ac', 'speedFeet', 'initiative']) {
            const raw = form.get(key);
            if (raw !== '' && raw != null && Number.isFinite(Number(raw))) patch[key] = Number(raw);
        }
        socket.emit('combat-update-combatant', { combatantId: id, patch });
    });

    content.querySelectorAll('[data-condition]').forEach(button => button.addEventListener('click', () => {
        if (!socket || selectedObject !== object) return;
        socket.emit('combat-effect', { combatantId: id, key: button.dataset.condition, add: !button.classList.contains('active') });
    }));

    content.querySelectorAll('[data-selection-act]').forEach(button => button.addEventListener('click', () => {
        if (!socket || selectedObject !== object) return;
        const action = button.dataset.selectionAct;
        if (action === 'move') {
            setTool('move', { preserveSelection: true });
        } else if (action === 'focus') {
            frameCameraOn(object.position);
        } else if (action === 'duplicate') {
            const clone = JSON.parse(JSON.stringify(object.userData.objectData || {}));
            delete clone.id;
            delete clone.addedBy;
            if (isStructureType(clone.type)) clone.structureId = newStructureIdentity('structure');
            clone.position = { x: object.position.x + GRID_CELL_SIZE, y: object.position.y, z: object.position.z + GRID_CELL_SIZE };
            socket.emit('add-object', clone);
        } else if (action === 'delete') {
            if (confirm(`Delete ${identity.displayName} from this map?`)) socket.emit('delete-object', { id });
        } else if (action === 'studio') {
            workspace?.openStudio(`/?character=${encodeURIComponent(char.id)}`, `${char.name || 'Character'} · Studio`);
        } else if (action === 'instances') {
            deselectObject({ restoreContext: false });
            setCharacterTab('instances');
            workspace?.showPanel('object-menu', 'Library', 'Characters');
        } else if (action === 'combat-start') {
            socket.emit('combat-start', {});
        } else if (action === 'combat-add') {
            socket.emit('combat-add-combatant', { objectId: id });
        } else if (action === 'combat-remove') {
            socket.emit('combat-remove-combatant', { combatantId: id });
        }
    }));

    if (open && workspace) {
        workspace.showPanel('selection-panel', identity.displayName, selectedTypeLabel(type));
        if (currentTool == null) workspace.setMode('Selected');
    }
}

function selectObject(object, { openInspector = true } = {}) {
    if (!object) return;
    if (!selectedObject && workspace) {
        selectionReturnContext = {
            panel: workspace.currentPanel(),
            open: workspace.isInspectorOpen()
        };
    }
    if (selectedObject) deselectObject({ restoreContext: false, preserveReturn: true });
    selectedObject = object;
    dragStartPos = object.position.clone(); // combat movement is measured from here
    setObjectSelected(object, true);
    renderSelectionInspector({ open: openInspector });
    updateHintBar();
}

function deselectObject({ restoreContext = true, preserveReturn = false } = {}) {
    if (selectedObject) setObjectSelected(selectedObject, false);
    selectedObject = null;
    dragStartPos = null;
    hideMoveTooltip();
    if (restoreContext && workspace && workspace.currentPanel() === 'selection-panel') {
        const context = selectionReturnContext;
        if (context?.open && context.panel && context.panel !== 'selection-panel') workspace.showPanel(context.panel);
        else workspace.closeInspector();
        workspace.setMode(currentModeLabel());
    }
    if (!preserveReturn) selectionReturnContext = null;
    updateHintBar();
}

// --- Combat mode -------------------------------------------------------------

function findObjectMesh(id) { return objects.find(o => o.userData.syncId === id); }

// Every combat-updated re-applies the whole state on this screen.
function setCombat(combat) {
    const hadCombat = !!combatState;
    combatState = combat;
    if (combatTracker) combatTracker.setState(combat);
    if (combatOverlays) combatOverlays.sync(combat);
    answerStatsPending();
    const toggle = document.getElementById('btn-combat-toggle');
    if (toggle) toggle.classList.toggle('hidden', !!combat);
    if (workspace) {
        workspace.setDockVisible(true);
        const active = combat?.started && combat.combatants[combat.activeId];
        const activeObject = active && findObjectMesh(active.id);
        const activeName = activeObject ? objectIdentity(activeObject, objects).displayName : active?.name;
        const gathering = combat && !combat.started ? `${Object.keys(combat.combatants).length} combatants · Roll initiative` : '';
        workspace.setEncounterStatus(combat ? (active ? `Round ${combat.round} · ${activeName}` : gathering || `Round ${combat.round || '—'}`) : 'Ready to start', !!combat);
        if (combat && !hadCombat) workspace.setDockExpanded(true);
    }
    if (!combat) { pendingAttack = null; pendingSpell = null; }
    if (selectedObject) renderSelectionInspector({ open: false });
    updateHintBar();
}

// GM fallback for statsPending combatants: the GM client has every character
// (and the SRD once loaded), so a fight never stalls on an offline owner.
// answeredStats stops re-sends while our write is still in flight (each
// broadcast re-runs this pass before statsPending reads false).
const answeredStats = new Set();
function answerStatsPending() {
    if (!combatState || !SRD || !socket) return;
    for (const c of Object.values(combatState.combatants)) {
        if (!c.statsPending || !c.charId || answeredStats.has(c.id)) continue;
        const char = allCharacters.find(x => x.id === c.charId);
        if (!char) continue;
        answeredStats.add(c.id);
        socket.emit('combat-set-stats', { combatantId: c.id, ...deriveCombatStats(char, SRD) });
    }
}

function beginTargetPick(combatantId, attackIndex, attack) {
    pendingSpell = null;
    pendingAttack = { combatantId, attackIndex };
    if (combatTracker) combatTracker.flash(`Pick a target for ${attack.name}: click a token (Esc cancels)`);
    updateHintBar();
}

function beginSpellPick(combatantId, spellIndex, spell) {
    pendingAttack = null;
    pendingSpell = { combatantId, spellIndex };
    if (combatTracker) combatTracker.flash(`Pick a target for ${spell.name}: click a token (Esc cancels)`);
    updateHintBar();
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

// --- UI Management (Right Menu) ---
function setSelectedObjectType(type, data = null) {
    if (selectedObjectType === type && selectedObjectData === data) {
        deselectObjectType();
    } else {
        selectedObjectType = type;
        selectedObjectData = data;
        setTool('add');

        document.querySelectorAll('#object-menu .menu-button, #object-menu .character-card-place').forEach(btn => {
            btn.classList.remove('active');
        });
        if (type === 'character') {
            const charBtn = document.querySelector(`button[data-char-id="${data.id}"]`);
            if (charBtn) charBtn.classList.add('active');
        } else if (type === 'monster') {
            const monsterBtn = document.querySelector(`button[data-monster-index="${data.index}"]`);
            if (monsterBtn) monsterBtn.classList.add('active');
        } else {
            if (menuButtons[type]) menuButtons[type].classList.add('active');
        }
    }
}

function deselectObjectType() {
    selectedObjectType = null;
    selectedObjectData = null;
    if (currentTool === 'add') {
        setTool(null);
    }
    document.querySelectorAll('#object-menu .menu-button, #object-menu .character-card-place').forEach(btn => {
        btn.classList.remove('active');
    });
}

function rebuildMonsterFilters(monsters) {
    const typeSelect = document.getElementById('monster-type-filter');
    const crSelect = document.getElementById('monster-cr-filter');
    if (!typeSelect || !crSelect) return;
    const selectedType = typeSelect.value;
    const selectedCR = crSelect.value;
    const types = [...new Set(monsters.map(monster => String(monster.type || '').toLowerCase()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
    const challenges = [...new Set(monsters.map(monster => Number(monster.challenge_rating)).filter(Number.isFinite))]
        .sort((a, b) => a - b);
    typeSelect.replaceChildren(new Option('All types', ''));
    for (const type of types) typeSelect.add(new Option(type[0].toUpperCase() + type.slice(1), type));
    crSelect.replaceChildren(new Option('All CRs', ''));
    for (const challenge of challenges) crSelect.add(new Option(`CR ${monsterChallengeLabel(challenge)}`, String(challenge)));
    if (types.includes(selectedType)) typeSelect.value = selectedType;
    if (challenges.some(value => String(value) === selectedCR)) crSelect.value = selectedCR;
}

function ensureMonsterLibraryLoaded() {
    if (monsterCatalogPromise) return monsterCatalogPromise;
    monsterCatalogState = 'loading';
    monsterLoadError = '';
    renderMonsterLibrary();
    monsterCatalogPromise = loadSRDMonsters().then(monsters => {
        srdMonsters = Array.isArray(monsters) ? monsters : [];
        monsterCatalogState = 'ready';
        renderMonsterLibrary();
        return srdMonsters;
    }).catch(error => {
        monsterCatalogState = 'error';
        monsterLoadError = error?.message || 'load failed';
        monsterCatalogPromise = null;
        renderMonsterLibrary();
        console.error('SRD monster load failed:', error);
        return [];
    });
    return monsterCatalogPromise;
}

function renderMonsterLibrary() {
    const list = document.getElementById('monster-button-list');
    const status = document.getElementById('monster-library-status');
    if (!list || !status) return;
    status.disabled = monsterCatalogState !== 'idle' && monsterCatalogState !== 'error';
    const monsters = [...customMonsters, ...srdMonsters]
        .filter(monster => monster && monster.name)
        .sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.index).localeCompare(String(b.index)));
    rebuildMonsterFilters(monsters);
    const query = String(document.getElementById('monster-search')?.value || '').trim().toLowerCase();
    const type = document.getElementById('monster-type-filter')?.value || '';
    const challenge = document.getElementById('monster-cr-filter')?.value || '';
    const filtered = monsters.filter(monster => {
        const haystack = [monster.name, monster.type, monster.size, monster.alignment,
            monsterChallengeLabel(monster.challenge_rating)].join(' ').toLowerCase();
        return (!query || haystack.includes(query)) &&
            (!type || String(monster.type || '').toLowerCase() === type) &&
            (!challenge || String(Number(monster.challenge_rating)) === challenge);
    });
    list.replaceChildren();
    for (const monster of filtered) {
        const stats = monsterCombatStats(monster);
        const card = document.createElement('div');
        card.className = 'character-card monster-card';
        card.style.setProperty('--character-color', monsterColor(monster));

        const summary = document.createElement('div');
        summary.className = 'character-card-main';
        summary.title = (monster.special_abilities || []).concat(monster.actions || [])
            .slice(0, 4).map(action => `${action.name}: ${action.desc || ''}`).join('\n');
        const name = document.createElement('span');
        name.className = 'character-card-name';
        name.textContent = monster.name || 'Unnamed monster';
        const meta = document.createElement('span');
        meta.className = 'character-card-meta';
        meta.textContent = `CR ${monsterChallengeLabel(monster.challenge_rating)} · ${monster.size || 'Medium'} ${monster.type || 'creature'} · AC ${stats?.ac ?? '—'} · HP ${stats?.maxHP ?? '—'}`;
        if (monster.custom) {
            const source = document.createElement('span');
            source.className = 'monster-card-source';
            source.textContent = 'custom';
            meta.append(source);
        }
        summary.append(name, meta);

        const place = document.createElement('button');
        place.type = 'button';
        place.className = 'character-card-place monster-card-place';
        place.textContent = 'Place';
        place.title = `Place ${monster.name || 'this monster'} on the map`;
        place.dataset.monsterIndex = monster.index || monster.name;
        place.classList.toggle('active', selectedObjectType === 'monster' && selectedObjectData === monster);
        place.addEventListener('click', () => setSelectedObjectType('monster', monster));
        card.append(summary, place);
        list.appendChild(card);
    }
    const sourceSummary = `${srdMonsters.length} SRD · ${customMonsters.length} custom`;
    if (monsterCatalogState === 'error' && !srdMonsters.length) {
        status.textContent = `${customMonsters.length} custom · SRD catalog unavailable (${monsterLoadError})`;
    } else if (monsterCatalogState === 'idle') {
        status.textContent = `${customMonsters.length} custom · Load SRD monsters`;
    } else if (monsterCatalogState === 'loading') {
        status.textContent = 'Loading SRD monsters…';
    } else if (!monsters.length) {
        status.textContent = 'No monsters available';
    } else {
        status.textContent = filtered.length === monsters.length
            ? sourceSummary : `${filtered.length} of ${monsters.length} · ${sourceSummary}`;
    }
}

function loadCharactersToMenu(characters) {
    const listContainer = document.getElementById('character-button-list');
    listContainer.innerHTML = '';

    if (!Array.isArray(characters) || characters.length === 0) {
        listContainer.innerHTML = '<div class="workspace-empty">No characters yet.<br><button class="workspace-primary" data-workspace-studio="/">Create a character</button></div>';
        return;
    }

    characters.forEach(char => {
        const card = document.createElement('div');
        card.className = 'character-card';
        card.style.setProperty('--character-color', char.color || '#7f8a99');

        const summary = document.createElement('div');
        summary.className = 'character-card-main';
        summary.innerHTML = `<span class="character-card-name"></span><span class="character-card-meta"></span>`;
        summary.querySelector('.character-card-name').textContent = char.name || 'Unnamed';
        summary.querySelector('.character-card-meta').textContent = `${char.owner || 'unowned'} · ${char.race || 'character'}`;

        const place = document.createElement('button');
        place.className = 'character-card-place';
        place.textContent = 'Place';
        place.title = `Place ${char.name || 'this character'} on the map`;
        place.dataset.charId = char.id;
        place.addEventListener('click', () => setSelectedObjectType('character', char));

        card.append(summary, place);
        listContainer.appendChild(card);
    });

    const studio = document.createElement('button');
    studio.className = 'workspace-secondary';
    studio.dataset.workspaceStudio = '/';
    studio.textContent = 'Create or edit characters';
    listContainer.appendChild(studio);
}

// --- Characters section tabs: Spawn (place a character) | Instances ---
function setCharacterTab(tab) {
    document.getElementById('char-tab-spawn').classList.toggle('active', tab === 'spawn');
    document.getElementById('char-tab-instances').classList.toggle('active', tab === 'instances');
    document.getElementById('character-button-list').classList.toggle('hidden', tab !== 'spawn');
    document.getElementById('character-instance-list').classList.toggle('hidden', tab !== 'instances');
    if (tab === 'instances' && socket) socket.emit('get-character-instances'); // fresh on open
}

// Tactical path of the province containing a world position (inverse of
// pathWorldCenter): each tier's hex is found relative to the accumulated
// centers of the tiers above it.
function worldToTacticalPath(x, z) {
    let key = 'world', cx = 0, cz = 0;
    for (let d = 0; d < TACTICAL_DEPTH; d++) {
        const h = worldToHexAtTier(d, x - cx, z - cz);
        key += `/${h.q},${h.r}`;
        const c = hexCenterAtTier(d, h.q, h.r);
        cx += c.x; cz += c.z;
    }
    return key;
}

// Click an instance row: focus the token if its room is already loaded,
// otherwise enter its map first ('@world' tokens land on their containing
// province) and descend onto it once map-state arrives.
function gotoInstance(inst) {
    if (!inst) return;
    if (selectedObject) deselectObject({ restoreContext: false });
    const pos = inst.position || { x: 0, y: 0, z: 0 };
    const sameRoom = inst.mapKey === currentMapKey ||
        (inst.mapKey === '@world' && !isPocket(currentMapKey) && isTacticalKey(currentMapKey));
    if (sameRoom) { frameCameraOn(pos); return; }
    pendingFocus = { ...pos };
    enterMap(inst.mapKey === '@world' ? worldToTacticalPath(pos.x, pos.z) : inst.mapKey);
}

function renderInstanceList() {
    const list = document.getElementById('character-instance-list');
    if (!list) return;
    list.innerHTML = '';
    if (!characterInstances.length) {
        list.innerHTML = '<p style="font-size: 12px; color: #999;">No character tokens on any map yet.</p>';
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
        by.textContent = `${inst.owner || 'unowned'} · spawned by ${inst.addedBy || 'unknown'}`;

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

// --- UI Management (Left Menu) ---
function setTool(toolName, { preserveSelection = false } = {}) {
    if (selectedObject && !preserveSelection) {
        deselectObject({ restoreContext: false });
    }
    if (currentTool === 'ruler' && toolName !== 'ruler') {
        ruler.clearAll(() => socket.emit('clear-rulers'));
    }
    if (toolName !== 'ruler') {
        ruler.hideTooltip();
    }
    if (toolName !== 'build') {
        buildBrush.buildingPickMode = null;
        buildBrush.pickingLevel = false;
    }
    currentTool = toolName;
    if (toolName !== 'add' && toolName !== null) {
        deselectObjectType();
    }
    const activeKey = (toolName === 'add' || toolName === null) ? 'library' : toolName;
    for (const key in toolMenuButtons) {
        toolMenuButtons[key].classList.toggle('active', key === activeKey);
    }
    if (workspace) {
        workspace.setMode(currentModeLabel());
    }
    updateTerrainPanel();
}

// --- Build tool (tile brush) logic ---
function shortBuildingId(id) {
    if (!id) return 'legacy / ungrouped';
    const tail = String(id).split('-').pop() || String(id);
    return tail.slice(-8);
}

function buildingObjects(buildingId = buildBrush.buildingId) {
    return objects.filter(object => {
        if (!isStructureType(object.userData.objectType)) return false;
        return structureBuildingId(object.userData.objectData) === buildingId;
    });
}

function buildingStoreyObjects(level = buildBrush.level, buildingId = buildBrush.buildingId) {
    return buildingObjects(buildingId).filter(object =>
        structureStoreyLevel(object.userData.objectData || {}) === level);
}

function structureDatumFromObject(object) {
    const data = object?.userData?.objectData || {};
    return round2(structureBuildingDatum(data, object?.position?.y));
}

function setBuildBuildingStatus(message, isError = false) {
    const status = document.getElementById('build-building-status');
    if (!status) return;
    status.textContent = message || '';
    status.classList.toggle('is-error', !!isError);
}

function clearPendingStructureBatches(message, isError = false) {
    if (!pendingStructureBatches.size) return false;
    pendingStructureBatches.clear();
    setBuildBuildingStatus(message, isError);
    syncBuildControls();
    return true;
}

function startNewBuilding() {
    if (pendingStructureBatches.size) return;
    buildBrush.buildingId = newStructureIdentity('building');
    buildBrush.datumY = null;
    buildBrush.buildingPickMode = null;
    buildBrush.pickingLevel = false;
    buildDrag = null;
    clearBuildGhost();
    setBuildBuildingStatus('New pieces share this building until you choose another.');
    syncBuildControls();
    updateHintBar();
}

function setBuildingPickMode(mode) {
    if (pendingStructureBatches.size) return;
    buildBrush.buildingPickMode = mode === 'pick' || mode === 'adopt' ? mode : null;
    if (buildBrush.buildingPickMode) buildBrush.pickingLevel = false;
    buildDrag = null;
    clearBuildGhost();
    if (mode === 'pick') {
        setBuildBuildingStatus('Click a grouped structure to activate its building.');
    } else if (mode === 'adopt') {
        setBuildBuildingStatus('Click exactly one structure to add it to the active building.');
    } else {
        setBuildBuildingStatus('Building selection cancelled.');
    }
    syncBuildControls();
    updateHintBar();
}

function emitStructureBatch(action, payload, context) {
    if (!socket || !socket.connected || !mapReload.authenticated) {
        setBuildBuildingStatus('Connect to the server before editing a building.', true);
        return null;
    }
    const requestId = newStructureIdentity('structure');
    pendingStructureBatches.set(requestId, { action, ...context });
    buildDrag = null;
    clearBuildGhost();
    socket.emit('structure-batch', { requestId, action, ...payload });
    syncBuildControls();
    return requestId;
}

function handleBuildingPick(event) {
    const hit = pickBuildHit(event);
    if (!hit) {
        setBuildBuildingStatus('No structure under the cursor.', true);
        return;
    }
    const object = hit.object;
    const data = object.userData.objectData || {};
    if (buildBrush.buildingPickMode === 'pick') {
        const buildingId = structureBuildingId(data);
        if (!buildingId) {
            setBuildBuildingStatus('That is a legacy piece. Use Adopt piece to assign it explicitly.', true);
            return;
        }
        buildBrush.buildingId = buildingId;
        buildBrush.datumY = structureDatumFromObject(object);
        if (Number(data.levelHeight) > 0) buildBrush.levelHeight = Number(data.levelHeight);
        buildBrush.buildingPickMode = null;
        setBuildBuildingStatus(`Active building ${shortBuildingId(buildingId)}.`);
        syncBuildControls();
        updateHintBar();
        return;
    }

    const objectId = object.userData.syncId;
    if (!objectId) return;
    if (structureBuildingId(data) === buildBrush.buildingId && data.structureId) {
        buildBrush.buildingPickMode = null;
        setBuildBuildingStatus('That piece already belongs to the active building.');
        syncBuildControls();
        return;
    }
    const grouped = buildingObjects();
    const pieceLevelHeight = Number(data.levelHeight) > 0
        ? Number(data.levelHeight) : DEFAULT_LEVEL_HEIGHT;
    if (grouped.length) {
        const groupData = grouped[0].userData.objectData || {};
        const groupLevelHeight = Number(groupData.levelHeight) > 0
            ? Number(groupData.levelHeight) : DEFAULT_LEVEL_HEIGHT;
        const groupDatum = structureDatumFromObject(grouped[0]);
        buildBrush.levelHeight = groupLevelHeight;
        buildBrush.datumY = groupDatum;
        if (Math.abs(pieceLevelHeight - groupLevelHeight) > 0.001) {
            setBuildBuildingStatus('That piece uses a different storey rise and cannot be adopted safely.', true);
            return;
        }
        if (!structureDatumCompatible(data, groupDatum, object.position.y)) {
            setBuildBuildingStatus('That piece uses a different building datum and cannot be adopted safely.', true);
            return;
        }
    } else if (buildBrush.datumY != null &&
        !structureDatumCompatible(data, buildBrush.datumY, object.position.y)) {
        setBuildBuildingStatus('That piece uses a different building datum and cannot be adopted safely.', true);
        return;
    }
    if (!grouped.length) buildBrush.levelHeight = pieceLevelHeight;
    if (buildBrush.datumY == null) buildBrush.datumY = structureDatumFromObject(object);
    buildBrush.buildingPickMode = null;
    setBuildBuildingStatus('Assigning the selected piece…');
    emitStructureBatch('adopt', {
        buildingId: buildBrush.buildingId,
        buildingDatumY: buildBrush.datumY,
        objectIds: [objectId]
    }, { buildingId: buildBrush.buildingId, objectIds: [objectId] });
    updateHintBar();
}

function duplicateActiveStorey(direction) {
    const destinationLevel = buildBrush.level + (direction < 0 ? -1 : 1);
    if (destinationLevel < BUILD_LEVEL_MIN || destinationLevel > BUILD_LEVEL_MAX) return;
    const source = buildingStoreyObjects();
    if (!source.length) {
        setBuildBuildingStatus(`No pieces from the active building belong to ${buildLevelName()}.`, true);
        return;
    }
    const existing = buildingStoreyObjects(destinationLevel);
    if (existing.length && !confirm(`${buildLevelName(destinationLevel)} already has ${existing.length} piece${existing.length === 1 ? '' : 's'} in this building. Duplicate into it anyway?`)) {
        return;
    }
    if (buildBrush.datumY == null) buildBrush.datumY = structureDatumFromObject(source[0]);
    const expectedSourceIds = source.map(object => object.userData.syncId).filter(Boolean).sort();
    const expectedDestinationIds = existing.map(object => object.userData.syncId).filter(Boolean).sort();
    setBuildBuildingStatus(`Duplicating ${source.length} piece${source.length === 1 ? '' : 's'} to ${buildLevelName(destinationLevel)}…`);
    emitStructureBatch('duplicate-storey', {
        buildingId: buildBrush.buildingId,
        buildingDatumY: buildBrush.datumY,
        sourceLevel: buildBrush.level,
        destinationLevel,
        expectedSourceIds,
        expectedDestinationIds,
        allowOccupiedDestination: existing.length > 0
    }, { buildingId: buildBrush.buildingId, sourceLevel: buildBrush.level, destinationLevel });
}

function applyStructureBatchResult(result = {}) {
    // Every non-pocket navigation key is a lens onto the same persisted @world
    // state. Accept @world (or another unified context path) as equivalent, but
    // never leak a late pocket result into a different state.
    if (result.key && result.key !== currentMapKey &&
        (isPocket(result.key) || isPocket(currentMapKey))) return;
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
        if (object) updateObjectPresentation(object, entry.patch);
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
    applyBuildLevelVisibility();
    if (objectNameplates) objectNameplates.sync(objects);

    const pending = result.requestId && pendingStructureBatches.get(result.requestId);
    if (!pending) {
        syncBuildControls();
        return;
    }
    pendingStructureBatches.delete(result.requestId);
    if (pending.action === 'duplicate-storey') {
        setBuildBuildingStatus(`Duplicated ${created.length} piece${created.length === 1 ? '' : 's'} to ${buildLevelName(pending.destinationLevel)}.`);
        if (pending.buildingId === buildBrush.buildingId) setBuildLevel(pending.destinationLevel);
        else syncBuildControls();
    } else {
        setBuildBuildingStatus(`Adopted ${updated.length} piece${updated.length === 1 ? '' : 's'} into the active building.`);
        syncBuildControls();
    }
}

function buildActive() { return currentTool === 'build' && isTacticalKey(); }
function snapCorner(p) {
    return { x: Math.round(p.x / GRID_CELL_SIZE) * GRID_CELL_SIZE,
             z: Math.round(p.z / GRID_CELL_SIZE) * GRID_CELL_SIZE };
}
function snapCellIndex(p) {
    return { x: Math.floor(p.x / GRID_CELL_SIZE), z: Math.floor(p.z / GRID_CELL_SIZE) };
}
function round2(v) { return Math.round(v * 100) / 100; }

function buildLevelName(level = buildBrush.level) {
    if (level < 0) return `Basement ${Math.abs(level)}`;
    if (level > 0) return `Level ${level}`;
    return 'Ground';
}

function buildLevelY(level = buildBrush.level) {
    return buildBrush.datumY == null ? null : round2(buildBrush.datumY + level * buildBrush.levelHeight);
}

function resolveBuildPlacement(p, { persistDatum = true } = {}) {
    const level = buildBrush.level;
    const heightMode = level === 0 && buildBrush.followTerrain ? 'terrain' : 'flat';
    let datum = buildBrush.datumY;
    // The first piece fixes a common datum even when its ground geometry follows
    // terrain. Upper-storey copies must align to this datum, not to each source
    // piece's terrain-derived anchor/ys offsets.
    if (datum == null) {
        datum = round2(terrain.sampleHeight(p.x, p.z));
        if (persistDatum) {
            buildBrush.datumY = datum;
            syncBuildControls();
        }
    }
    const baseY = heightMode === 'terrain'
        ? round2(terrain.sampleHeight(p.x, p.z))
        : round2(datum + level * buildBrush.levelHeight);
    return {
        level, levelHeight: buildBrush.levelHeight, heightMode, baseY,
        buildingDatumY: datum
    };
}

// A cover is always flat at the datum above the active storey, even when its
// ground floor follows terrain. The closed underside becomes that room's
// ceiling; the roof profile rises from this next-level plane.
function resolveRoofPlacement(p, { persistDatum = true } = {}) {
    let datum = buildBrush.datumY;
    if (datum == null) {
        datum = round2(terrain.sampleHeight(p.x, p.z));
        if (persistDatum) {
            buildBrush.datumY = datum;
            syncBuildControls();
        }
    }
    const coversLevel = buildBrush.level;
    const level = coversLevel + 1;
    return {
        level, coversLevel, levelHeight: buildBrush.levelHeight, heightMode: 'flat',
        baseY: round2(datum + level * buildBrush.levelHeight), buildingDatumY: datum
    };
}

function authoredStructureIdentity(placement) {
    const identity = {
        buildingId: buildDrag?.buildingId || buildBrush.buildingId,
        buildingDatumY: Number.isFinite(Number(buildDrag?.buildingDatumY))
            ? Number(buildDrag.buildingDatumY) : placement.buildingDatumY
    };
    // Preview data does not need to consume a durable per-piece identity. Every
    // committed drag already owns one from pointerdown.
    if (buildDrag?.structureId) identity.structureId = buildDrag.structureId;
    return identity;
}

// Wall run data from anchor corner a to cursor corner b. The first snapped
// movement locks the first leg, then moving off that axis adds a second leg so
// one drag can author a clean L. Ground heights stay baked per piece so both
// screens (and later loads) rebuild the exact same wall (see structures.js).
function wallData(a, b) {
    const gesture = wallGesturePath(a, b,
        buildDrag?.kind === 'wall' ? buildDrag.wallAxis : null, MAX_RUN);
    if (buildDrag?.kind === 'wall') {
        buildDrag.wallAxis = gesture.axis;
        buildDrag.wallCorners = gesture.points;
    }
    const corners = gesture.points;
    const anchor = corners[0] || a;
    const end = corners[corners.length - 1] || anchor;
    const path = corners.map(point => ({
        x: round2(point.x - anchor.x), z: round2(point.z - anchor.z)
    }));
    const placement = buildDrag || resolveBuildPlacement(a, { persistDatum: false });
    const y0 = placement.heightMode === 'terrain'
        ? round2(terrain.sampleHeight(anchor.x, anchor.z))
        : placement.baseY;
    const ys = [];
    for (let p = 1; p < corners.length; p++) {
        const start = corners[p - 1], finish = corners[p];
        const dx = Math.round((finish.x - start.x) / GRID_CELL_SIZE);
        const dz = Math.round((finish.z - start.z) / GRID_CELL_SIZE);
        const n = Math.abs(dx) + Math.abs(dz);
        const ux = Math.sign(dx), uz = Math.sign(dz);
        for (let i = 0; i < n; i++) {
            ys.push(placement.heightMode === 'terrain'
                ? round2(terrain.sampleHeight(start.x + ux * (i + 0.5) * GRID_CELL_SIZE,
                                              start.z + uz * (i + 0.5) * GRID_CELL_SIZE) - y0)
                : 0);
        }
    }
    return { type: 'wall', ...authoredStructureIdentity(placement),
             style: buildBrush.style, scruffy: buildBrush.scruffy,
             wallHeight: buildBrush.wallHeight, seed: buildDrag ? buildDrag.seed : 1,
             level: placement.level, levelHeight: placement.levelHeight, heightMode: placement.heightMode,
             position: { x: anchor.x, y: y0, z: anchor.z },
             bx: round2(end.x - anchor.x), bz: round2(end.z - anchor.z), path, ys };
}

// Floor rectangle data between anchor cell a and cursor cell b (cell indices).
// Oversized drags clamp toward the anchor.
function floorData(a, b) {
    let x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    let z0 = Math.min(a.z, b.z), z1 = Math.max(a.z, b.z);
    if (x1 - x0 >= MAX_RUN) { if (b.x >= a.x) x1 = x0 + MAX_RUN - 1; else x0 = x1 - MAX_RUN + 1; }
    if (z1 - z0 >= MAX_RUN) { if (b.z >= a.z) z1 = z0 + MAX_RUN - 1; else z0 = z1 - MAX_RUN + 1; }
    const cols = x1 - x0 + 1, rows = z1 - z0 + 1;
    const px = x0 * GRID_CELL_SIZE, pz = z0 * GRID_CELL_SIZE;
    const center = { x: px + (cols / 2) * GRID_CELL_SIZE, z: pz + (rows / 2) * GRID_CELL_SIZE };
    const placement = buildDrag || resolveBuildPlacement(center, { persistDatum: false });
    const y0 = placement.heightMode === 'terrain'
        ? round2(terrain.sampleHeight(center.x, center.z))
        : placement.baseY;
    const ys = [];
    for (let tz = 0; tz < rows; tz++) {
        for (let tx = 0; tx < cols; tx++) {
            ys.push(placement.heightMode === 'terrain'
                ? round2(terrain.sampleHeight(px + (tx + 0.5) * GRID_CELL_SIZE,
                                              pz + (tz + 0.5) * GRID_CELL_SIZE) - y0)
                : 0);
        }
    }
    return { type: 'floor', ...authoredStructureIdentity(placement),
             style: buildBrush.style, scruffy: buildBrush.scruffy,
             seed: buildDrag ? buildDrag.seed : 1,
             level: placement.level, levelHeight: placement.levelHeight, heightMode: placement.heightMode,
             position: { x: px, y: y0, z: pz }, cols, rows, ys };
}

// Roof/ceiling rectangle over the active storey. Unlike a floor patch it has
// no terrain-baked tile offsets: every cover shares the building datum and is
// stored at the next level so isolating the room below cuts it away.
function roofData(a, b) {
    let x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    let z0 = Math.min(a.z, b.z), z1 = Math.max(a.z, b.z);
    if (x1 - x0 >= MAX_RUN) { if (b.x >= a.x) x1 = x0 + MAX_RUN - 1; else x0 = x1 - MAX_RUN + 1; }
    if (z1 - z0 >= MAX_RUN) { if (b.z >= a.z) z1 = z0 + MAX_RUN - 1; else z0 = z1 - MAX_RUN + 1; }
    const cols = x1 - x0 + 1, rows = z1 - z0 + 1;
    const px = x0 * GRID_CELL_SIZE, pz = z0 * GRID_CELL_SIZE;
    const center = { x: px + cols * GRID_CELL_SIZE / 2, z: pz + rows * GRID_CELL_SIZE / 2 };
    const placement = buildDrag || resolveRoofPlacement(center, { persistDatum: false });
    return {
        type: 'roof', ...authoredStructureIdentity(placement),
        style: buildBrush.style, scruffy: buildBrush.scruffy,
        seed: buildDrag ? buildDrag.seed : 1,
        level: placement.level, coversLevel: placement.coversLevel,
        levelHeight: placement.levelHeight, heightMode: 'flat',
        roofShape: buildBrush.roofShape, pitch: buildBrush.roofPitch,
        overhang: GRID_CELL_SIZE * 0.16,
        position: { x: px, y: placement.baseY, z: pz }, cols, rows
    };
}

// Straight stairs occupy the cells from a through b on the dominant axis and
// connect the active level to the immediately adjacent level. They always use
// a flat start height, even when the ground floor itself follows terrain.
function stairData(a, b) {
    let dx = b.x - a.x, dz = b.z - a.z;
    let ux = 0, uz = 0, cells = 1;
    if (Math.abs(dx) >= Math.abs(dz)) {
        ux = Math.sign(dx) || 1;
        cells = Math.min(MAX_RUN, Math.abs(dx) + 1);
    } else {
        uz = Math.sign(dz) || 1;
        cells = Math.min(MAX_RUN, Math.abs(dz) + 1);
    }
    const start = { x: (a.x + 0.5) * GRID_CELL_SIZE, z: (a.z + 0.5) * GRID_CELL_SIZE };
    const placement = buildDrag || resolveBuildPlacement(start, { persistDatum: false });
    const baseY = placement.heightMode === 'terrain'
        ? round2(terrain.sampleHeight(start.x, start.z))
        : placement.baseY;
    const direction = buildBrush.stairDirection < 0 ? -1 : 1;
    return {
        type: 'stair', ...authoredStructureIdentity(placement),
        style: buildBrush.style, scruffy: buildBrush.scruffy,
        seed: buildDrag ? buildDrag.seed : 1,
        level: placement.level, toLevel: placement.level + direction,
        levelHeight: placement.levelHeight, heightMode: 'flat',
        position: { x: start.x, y: baseY, z: start.z },
        bx: ux * cells * GRID_CELL_SIZE, bz: uz * cells * GRID_CELL_SIZE,
        rise: direction * placement.levelHeight, width: GRID_CELL_SIZE * 0.9
    };
}

// Fixed levels use an invisible horizontal authoring plane. This is what makes
// basement editing possible after the terrain is cut away; level 0 retains the
// old terrain-following raycast.
function pointerToBuildSurface(event) {
    if (buildBrush.level === 0 && buildBrush.followTerrain) return pointerToGround(event);
    castFromPointer(event, { renderer, camera, raycaster, mouse });
    const hit = new THREE.Vector3();
    if (buildBrush.datumY == null) {
        // The basement cutaway may already have hidden every renderable ground
        // mesh. Intersect y=0 for XZ, then ask the terrain model for its datum.
        const zeroPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        if (!raycaster.ray.intersectPlane(zeroPlane, hit)) return null;
        const world = sceneToWorld(hit);
        world.y = terrain.sampleHeight(world.x, world.z);
        return world;
    }
    const y = buildLevelY();
    const authoringPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
    return raycaster.ray.intersectPlane(authoringPlane, hit) ? sceneToWorld(hit) : null;
}

function findBuildLevelHit(event) {
    castFromPointer(event, { renderer, camera, raycaster, mouse });
    const supportedTypes = buildBrush.mode === 'roof'
        ? ['floor', 'stair']
        : ['floor', 'stair', 'roof'];
    const candidates = objects.filter(o => o.visible && supportedTypes.includes(o.userData.objectType));
    const hit = raycaster.intersectObjects(candidates, true)[0];
    if (!hit) return null;
    let top = hit.object;
    while (top.parent && top.parent !== scene && top.parent !== worldGroup) top = top.parent;
    const object = objects.find(o => o === top);
    return object ? { object, point: sceneToWorld(hit.point) } : null;
}

function adoptBuildLevelAt(event, { structuresOnly = false, quiet = false } = {}) {
    const hit = findBuildLevelHit(event);
    if (hit) {
        const data = hit.object.userData.objectData || {};
        let level = structureLevel(data);
        let baseY = hit.object.position.y;
        if (data.type === 'stair') {
            const toLevel = Number.isFinite(Number(data.toLevel)) ? Math.round(Number(data.toLevel)) : level + Math.sign(Number(data.rise) || 1);
            const endY = baseY + (Number(data.rise) || 0);
            if (Math.abs(hit.point.y - endY) < Math.abs(hit.point.y - baseY)) {
                level = toLevel;
                baseY = endY;
            }
        }
        if (Number.isFinite(Number(data.levelHeight)) && Number(data.levelHeight) > 0) {
            buildBrush.levelHeight = Number(data.levelHeight);
        }
        const hitBuildingId = structureBuildingId(data);
        if (hitBuildingId) {
            buildBrush.buildingId = hitBuildingId;
            if (!quiet) setBuildBuildingStatus(`Active building ${shortBuildingId(hitBuildingId)}.`);
        }
        buildBrush.level = Math.max(BUILD_LEVEL_MIN, Math.min(BUILD_LEVEL_MAX, level));
        if (buildBrush.level < 0) buildBrush.isolate = true;
        const persistedDatum = Number(data.buildingDatumY);
        buildBrush.datumY = Number.isFinite(persistedDatum)
            ? round2(persistedDatum)
            : round2(baseY - buildBrush.level * buildBrush.levelHeight);
        buildBrush.followTerrain = buildBrush.level === 0 && data.heightMode !== 'flat';
    } else {
        if (structuresOnly) return false;
        const p = pointerToGround(event);
        if (!p) return false;
        buildBrush.level = 0;
        buildBrush.datumY = round2(p.y);
        buildBrush.followTerrain = true;
    }
    if (!quiet) buildBrush.pickingLevel = false;
    buildDrag = null;
    clearBuildGhost();
    syncBuildControls();
    applyBuildLevelVisibility();
    updateHintBar();
    return true;
}

// Rebuild the translucent ghost only when the snapped footprint (or brush
// settings) actually change — mousemove between snaps is free.
function updateBuildGhost(p) {
    if (buildBrush.pickingLevel) { clearBuildGhost(); return; }
    const mode = buildDrag ? buildDrag.kind : buildBrush.mode;
    if (mode === 'erase' || mode === 'opening' || mode === 'tile') { clearBuildGhost(); return; }
    let a, b;
    if (mode === 'wall') {
        b = snapCorner(p);
        a = buildDrag ? { x: buildDrag.ax, z: buildDrag.az } : b;
    } else {
        b = snapCellIndex(p);
        a = buildDrag ? { x: buildDrag.ax, z: buildDrag.az } : b;
    }
    let pathKey = '';
    if (mode === 'wall') {
        const gesture = wallGesturePath(a, b,
            buildDrag?.kind === 'wall' ? buildDrag.wallAxis : null, MAX_RUN);
        pathKey = gesture.points.map(point => `${point.x},${point.z}`).join(';');
        if (buildDrag?.kind === 'wall') {
            buildDrag.wallAxis = gesture.axis;
            buildDrag.wallCorners = gesture.points;
        }
    }
    const key = [mode, a.x, a.z, b.x, b.z, pathKey, buildBrush.style, buildBrush.scruffy,
                 buildBrush.wallHeight, buildBrush.level, buildBrush.levelHeight,
                 buildBrush.followTerrain, buildBrush.stairDirection,
                 buildBrush.roofShape, buildBrush.roofPitch,
                 buildDrag ? buildDrag.baseY : buildLevelY(), buildDrag ? buildDrag.seed : 0].join('|');
    if (key === buildGhostKey && buildGhost) return;
    clearBuildGhost();
    const data = mode === 'wall' ? wallData(a, b)
        : mode === 'stair' ? stairData(a, b)
            : mode === 'roof' ? roofData(a, b)
                : floorData(a, b);
    buildGhost = mode === 'wall' ? buildWallRun(data, { ghost: true })
        : mode === 'stair' ? buildStaircase(data, { ghost: true })
            : mode === 'roof' ? buildRoofPatch(data, { ghost: true })
                : buildFloorPatch(data, { ghost: true });
    buildGhost.position.set(data.position.x, data.position.y, data.position.z);
    worldGroup.add(buildGhost); // synced-object coords are world coords
    buildGhostKey = key;
}
function clearBuildGhost() {
    if (!buildGhost) return;
    worldGroup.remove(buildGhost);
    disposeBuiltObject(buildGhost);
    buildGhost = null;
    buildGhostKey = '';
}
function commitBuildDrag(p) {
    if (buildDrag.kind === 'wall') {
        const data = wallData({ x: buildDrag.ax, z: buildDrag.az }, snapCorner(p));
        if (!wallSegmentCount(data)) return; // click, no run
        socket.emit('add-object', data);
    } else if (buildDrag.kind === 'stair') {
        socket.emit('add-object', stairData({ x: buildDrag.ax, z: buildDrag.az }, snapCellIndex(p)));
    } else if (buildDrag.kind === 'roof') {
        socket.emit('add-object', roofData({ x: buildDrag.ax, z: buildDrag.az }, snapCellIndex(p)));
    } else {
        const b = snapCellIndex(p);
        socket.emit('add-object', floorData({ x: buildDrag.ax, z: buildDrag.az }, b));
    }
}
// Resolve the visible structure plus its edit-cell index. Wall, floor and roof
// pickers live on an edit-only layer and remain present across visible gaps.
function buildHitFromIntersections(hits, targetTypes = null) {
    for (const hit of hits) {
        let top = hit.object;
        let segmentIndex = Number.isInteger(top.userData.wallSegment) ? top.userData.wallSegment : null;
        let tileIndex = top.userData.structureTilePicker && Number.isInteger(hit.instanceId)
            ? hit.instanceId : null;
        while (top.parent && top.parent !== scene && top.parent !== worldGroup) {
            top = top.parent;
            if (segmentIndex == null && Number.isInteger(top.userData.wallSegment)) {
                segmentIndex = top.userData.wallSegment;
            }
        }
        const object = objects.find(o => o === top);
        if (object && isStructureType(object.userData.objectType) &&
            (!targetTypes || targetTypes.has(object.userData.objectType))) {
            return { object, segmentIndex, tileIndex };
        }
    }
    return null;
}

function pickBuildHit(event, targetTypes = null) {
    castFromPointer(event, { renderer, camera, raycaster, mouse });
    const visibleObjects = objects.filter(o => o.visible);
    const previousLayerMask = raycaster.layers.mask;
    raycaster.layers.set(STRUCTURE_EDIT_PICK_LAYER);
    const editHit = buildHitFromIntersections(
        raycaster.intersectObjects(visibleObjects, true), targetTypes);
    raycaster.layers.mask = previousLayerMask;
    if (editHit) return editHit;
    return buildHitFromIntersections(raycaster.intersectObjects(visibleObjects, true), targetTypes);
}

function updateWallSegment(object, segmentIndex, kind) {
    if (!socket || object?.userData.objectType !== 'wall') return;
    const data = object.userData.objectData || {};
    const count = wallSegmentCount(data);
    if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= count) return;
    const allowed = new Set(['door', 'window', 'gap', 'solid']);
    if (!allowed.has(kind)) return;
    const previous = Array.isArray(data.segments) ? data.segments : [];
    const segments = Array.from({ length: count }, (_, i) => allowed.has(previous[i]) ? previous[i] : null);
    segments[segmentIndex] = kind;
    // Keep rapid consecutive edits cumulative while awaiting the server echo.
    object.userData.objectData = { ...data, segments };
    socket.emit('update-object', { id: object.userData.syncId, patch: { segments } });
}

function updateStructureTile(object, tileIndex, kind) {
    if (!socket || !object) return;
    const type = object.userData.objectType;
    if (type !== 'floor' && type !== 'roof') return;
    const data = object.userData.objectData || {};
    const count = structureTileCount(data);
    if (!Number.isInteger(tileIndex) || tileIndex < 0 || tileIndex >= count) return;
    if (kind !== 'gap' && kind !== 'solid') return;
    const previous = Array.isArray(data.tiles) ? data.tiles : [];
    const tiles = Array.from({ length: count }, (_, i) =>
        previous[i] === 'gap' || previous[i] === 'solid' ? previous[i] : null);
    tiles[tileIndex] = kind;
    // Keep rapid consecutive edits cumulative while awaiting the server echo.
    object.userData.objectData = { ...data, tiles };
    socket.emit('update-object', { id: object.userData.syncId, patch: { tiles } });
}
function setBuildMode(mode) {
    buildBrush.mode = mode;
    buildBrush.pickingLevel = false;
    buildBrush.buildingPickMode = null;
    buildDrag = null;
    clearBuildGhost();
    document.querySelectorAll('#build-modes .brush-mode').forEach(b =>
        b.classList.toggle('active', b.dataset.bmode === mode));
    syncBuildControls();
    applyBuildLevelVisibility();
    updateHintBar();
}
function setBuildStyle(style) {
    buildBrush.style = style;
    clearBuildGhost(); // next hover rebuilds in the new style
    document.querySelectorAll('#build-styles .brush-mode').forEach(b =>
        b.classList.toggle('active', b.dataset.bstyle === style));
}

function setBuildLevel(level) {
    if (pendingStructureBatches.size) return;
    buildBrush.level = Math.max(BUILD_LEVEL_MIN, Math.min(BUILD_LEVEL_MAX, Math.round(level)));
    if (buildBrush.level < 0) buildBrush.isolate = true;
    buildBrush.pickingLevel = false;
    buildBrush.buildingPickMode = null;
    buildDrag = null;
    clearBuildGhost();
    syncBuildControls();
    applyBuildLevelVisibility();
    updateHintBar();
}

function syncBuildControls() {
    const level = buildBrush.level;
    const levelY = buildLevelY(level);
    const grouped = buildingObjects();
    const storeyPieces = grouped.filter(object =>
        structureStoreyLevel(object.userData.objectData || {}) === level);
    const buildingReadout = document.getElementById('build-building-readout');
    if (buildingReadout) {
        buildingReadout.textContent = `Building ${shortBuildingId(buildBrush.buildingId)} · ${grouped.length} piece${grouped.length === 1 ? '' : 's'}`;
        buildingReadout.title = buildBrush.buildingId;
    }
    const batchPending = pendingStructureBatches.size > 0;
    const newBuilding = document.getElementById('build-new-building');
    if (newBuilding) newBuilding.disabled = batchPending;
    const pickBuilding = document.getElementById('build-pick-building');
    if (pickBuilding) {
        pickBuilding.classList.toggle('active', buildBrush.buildingPickMode === 'pick');
        pickBuilding.disabled = batchPending;
    }
    const adoptStructure = document.getElementById('build-adopt-structure');
    if (adoptStructure) {
        adoptStructure.classList.toggle('active', buildBrush.buildingPickMode === 'adopt');
        adoptStructure.disabled = batchPending;
    }
    const duplicateDown = document.getElementById('build-duplicate-down');
    if (duplicateDown) duplicateDown.disabled = batchPending || !storeyPieces.length || level <= BUILD_LEVEL_MIN;
    const duplicateUp = document.getElementById('build-duplicate-up');
    if (duplicateUp) duplicateUp.disabled = batchPending || !storeyPieces.length || level >= BUILD_LEVEL_MAX;
    const readout = document.getElementById('build-level-readout');
    if (readout) {
        let detail;
        if (buildBrush.mode === 'roof') {
            const roofY = buildLevelY(level + 1);
            detail = roofY == null ? 'cover height set on first drag' : `cover at Y ${roofY.toFixed(1)}`;
        } else if (level === 0 && buildBrush.followTerrain) detail = 'follows terrain';
        else if (levelY == null) detail = 'height set on first drag';
        else detail = `Y ${levelY.toFixed(1)} · ${level * buildBrush.levelHeight * FEET_PER_GRID_CELL >= 0 ? '+' : ''}${Math.round(level * buildBrush.levelHeight * FEET_PER_GRID_CELL)} ft`;
        readout.textContent = `${buildLevelName(level)} · ${detail}`;
    }
    const ground = document.getElementById('build-level-ground');
    if (ground) {
        ground.classList.toggle('active', level === 0);
        ground.disabled = batchPending;
    }
    const down = document.getElementById('build-level-down');
    const up = document.getElementById('build-level-up');
    if (down) down.disabled = batchPending || level <= BUILD_LEVEL_MIN;
    if (up) up.disabled = batchPending || level >= BUILD_LEVEL_MAX;
    const height = document.getElementById('build-level-height');
    if (height) {
        height.value = buildBrush.levelHeight;
        height.disabled = batchPending || grouped.length > 0;
        height.title = batchPending
            ? 'Wait for the current building edit to finish'
            : grouped.length > 0
                ? 'Storey rise is fixed after the first piece in a building'
                : 'Set the rise before authoring the first piece';
    }
    const heightVal = document.getElementById('build-level-height-val');
    if (heightVal) heightVal.textContent = `${Math.round(buildBrush.levelHeight * FEET_PER_GRID_CELL)} ft`;
    const follow = document.getElementById('build-follow-terrain');
    if (follow) { follow.checked = buildBrush.followTerrain; follow.disabled = level !== 0 || buildBrush.mode === 'roof'; }
    const auto = document.getElementById('build-auto-snap');
    if (auto) auto.checked = buildBrush.autoSnap;
    const isolate = document.getElementById('build-isolate-level');
    if (isolate) isolate.checked = buildBrush.isolate;
    const pick = document.getElementById('build-pick-level');
    if (pick) {
        pick.classList.toggle('active', buildBrush.pickingLevel);
        pick.textContent = buildBrush.pickingLevel ? 'Click map…' : 'Pick from map';
    }
    if (pick) pick.disabled = batchPending;
    const stairs = document.getElementById('build-stair-options');
    if (stairs) stairs.classList.toggle('hidden', buildBrush.mode !== 'stair');
    const walls = document.getElementById('build-wall-options');
    if (walls) walls.classList.toggle('hidden', buildBrush.mode !== 'wall');
    document.querySelectorAll('[data-stair-dir]').forEach(btn =>
        btn.classList.toggle('active', Number(btn.dataset.stairDir) === buildBrush.stairDirection));
    const openings = document.getElementById('build-opening-options');
    if (openings) openings.classList.toggle('hidden', buildBrush.mode !== 'opening');
    document.querySelectorAll('[data-opening-kind]').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.openingKind === buildBrush.openingKind));
    const tiles = document.getElementById('build-tile-options');
    if (tiles) tiles.classList.toggle('hidden', buildBrush.mode !== 'tile');
    document.querySelectorAll('[data-tile-kind]').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.tileKind === buildBrush.tileKind));
    const roofs = document.getElementById('build-roof-options');
    if (roofs) roofs.classList.toggle('hidden', buildBrush.mode !== 'roof');
    document.querySelectorAll('[data-roof-shape]').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.roofShape === buildBrush.roofShape));
    const roofPitch = document.getElementById('build-roof-pitch');
    if (roofPitch) {
        roofPitch.value = buildBrush.roofPitch;
        roofPitch.disabled = buildBrush.roofShape === 'flat';
    }
    const roofPitchVal = document.getElementById('build-roof-pitch-val');
    if (roofPitchVal) roofPitchVal.textContent = buildBrush.roofShape === 'flat'
        ? 'flat' : `${Math.round(buildBrush.roofPitch * 12)}:12`;
}

function restoreBuildCutaway() {
    if (!buildCutawayState) return;
    if (terrain) terrain.group.visible = buildCutawayState.terrain;
    if (plane) plane.visible = buildCutawayState.plane;
    buildCutawayState = null;
}

function applyBuildLevelVisibility() {
    for (const object of objects) {
        const type = object.userData.objectType;
        if (!isStructureType(type)) continue;
        const data = object.userData.objectData || { type };
        const authoringCover = currentTool === 'build' && buildBrush.mode === 'roof' && type === 'roof' &&
            Number(data.coversLevel) === buildBrush.level;
        object.visible = !buildBrush.isolate || authoringCover ||
            structureTouchesLevel(data, buildBrush.level);
    }
    const cutAwayTerrain = buildBrush.isolate && buildBrush.level < 0;
    if (cutAwayTerrain && terrain && plane) {
        if (!buildCutawayState) buildCutawayState = { terrain: terrain.group.visible, plane: plane.visible };
        terrain.group.visible = false;
        plane.visible = false;
        if (grass) grass.hide();
        if (trees) trees.hide();
    } else if (!cutAwayTerrain) {
        restoreBuildCutaway();
    }
}

// --- Fog of war tool logic ---
// Fog paints the unified world only (any zoom); pockets are never fogged.
function fogActive() { return currentTool === 'fog' && !isPocket() && terrainIsUnified; }
function setFogMode(mode) {
    fogBrush.mode = mode;
    document.querySelectorAll('#fog-modes .brush-mode').forEach(b =>
        b.classList.toggle('active', b.dataset.fmode === mode));
    updateHintBar();
}
// One dab of the fog brush: every lattice hex within the radius that isn't
// already in the wanted state, batched into a single update-fog emit. The
// per-stroke Set stops a drag from re-sending hexes it already touched (the
// mask itself only flips when the server's fog-updated echo lands).
function paintFogAt(event) {
    const p = pointerToGround(event);
    if (!p) return;
    const h = fogHexAt(p.x, p.z);
    const want = fogBrush.mode === 'reveal';
    const batch = [];
    for (const hk of hexesWithin(h.q, h.r, fogBrush.radius)) {
        if (fogStroke.has(hk)) continue;
        fogStroke.add(hk);
        if (fogMask.has(hk) !== want) batch.push(hk);
    }
    if (batch.length && socket) socket.emit('update-fog', { hexes: batch, revealed: want });
}

// --- View tool logic (steer player cameras) ---
// Active everywhere: the server matches recipients by space (any unified key =
// the one world; pockets match exactly), so the tool works wherever the GM is.
function viewActive() { return currentTool === 'view'; }
function setViewAction(a) {
    viewCtl.action = a;
    document.querySelectorAll('#view-actions .brush-mode').forEach(b =>
        b.classList.toggle('active', b.dataset.vaction === a));
    updateHintBar();
}
// Player rows from the presence roster (usernames are user input — textContent
// only, never innerHTML). Selection falls back to 'all' if the player left.
function renderViewPlayers() {
    const box = document.getElementById('view-players');
    if (!box) return;
    const players = playersRoster.filter(p => !p.isGM);
    if (viewCtl.target !== 'all' &&
        !players.some(p => p.username.toLowerCase() === viewCtl.target)) {
        viewCtl.target = 'all';
    }
    box.innerHTML = '';
    const mkRow = (label, value, sub) => {
        const b = document.createElement('button');
        b.className = 'brush-mode view-player' + (viewCtl.target === value ? ' active' : '');
        b.textContent = label;
        if (sub) {
            const s = document.createElement('span');
            s.className = 'vp-sub';
            s.textContent = sub;
            b.appendChild(s);
        }
        b.addEventListener('click', () => { viewCtl.target = value; renderViewPlayers(); updateHintBar(); });
        box.appendChild(b);
    };
    mkRow(players.length ? `All players (${players.length})` : 'All players (none online)', 'all');
    for (const p of players) {
        mkRow(p.username, p.username.toLowerCase(), isPocket(p.mapKey) ? 'pocket' : '');
    }
}
// The GM's own camera as a world-space pose (what "Bring to my view" sends).
function viewPoseFromHere() {
    const o = terrain.worldOrigin;
    return {
        pos: { x: camera.position.x + o.x, y: camera.position.y, z: camera.position.z + o.z },
        look: { x: controls.target.x + o.x, y: controls.target.y, z: controls.target.z + o.z }
    };
}
// Frame a world point the way focusCameraOn lands next to a placed object.
function viewPoseAt(p) {
    return { pos: { x: p.x + 20, y: p.y + 30, z: p.z + 20 }, look: { x: p.x, y: p.y, z: p.z } };
}
function emitViewCommand(pose, what, relocate) {
    if (!socket) return;
    socket.emit('camera-command', {
        target: viewCtl.target, pose,
        mode: viewCtl.fly ? 'fly' : 'snap',
        lock: viewCtl.lock,
        // "Bring to my view" relocates players to the GM's map/tier (crossing
        // spaces, e.g. into a pocket); point/token sends stay camera-only.
        mapKey: relocate ? currentMapKey : undefined
    });
    const who = viewCtl.target === 'all' ? 'all players' : viewCtl.target;
    setViewStatus(`${what} → ${who}${viewCtl.lock ? ' (locked)' : ''}`);
}
function setViewStatus(msg) {
    const el = document.getElementById('view-status');
    if (!el) return;
    el.textContent = msg;
    clearTimeout(viewStatusTimer);
    viewStatusTimer = setTimeout(() => { el.textContent = ''; }, 2500);
}
// Topmost synced object under the pointer (tokens/props; mirrors the pick in
// onPointerDown's default branch).
function pickSceneObject(event) {
    castFromPointer(event, { renderer, camera, raycaster, mouse });
    const hit = raycaster.intersectObjects(objects, true)[0];
    if (!hit) return null;
    let top = hit.object;
    while (top.parent && top.parent !== scene && top.parent !== worldGroup) top = top.parent;
    return objects.find(o => o === top) || null;
}

// --- Terrain editor logic ---
function terrainActive() { return currentTool === 'terrain' && isTacticalKey(); }
function updateTerrainPanel() {
    // Every authoring mode now owns the one context inspector. The page still
    // owns tool validity; the shell only decides where its controls appear.
    if (workspace) {
        if (currentTool === 'terrain' && isTacticalKey()) workspace.showPanel('terrain-panel', 'Terrain');
        else if (currentTool === 'terrain' && isHexLayer()) workspace.showPanel('biome-panel', 'Biomes');
        else if (currentTool === 'build' && isTacticalKey()) workspace.showPanel('build-panel', 'Build');
        else if (currentTool === 'fog' && !isPocket()) workspace.showPanel('fog-panel', 'Fog of War');
        else if (currentTool === 'view') workspace.showPanel('view-panel', 'Direct Players');
        else if (currentTool === 'add' || currentTool === null) workspace.showPanel('object-menu', 'Library');
        else workspace.closeInspector();
    }

    // Tool teardown remains page-owned.
    if (currentTool !== 'build') {
        buildDrag = null;
        buildBrush.pickingLevel = false;
        clearBuildGhost();
        syncBuildControls();
        applyBuildLevelVisibility();
    } else applyBuildLevelVisibility();
    if (fogOverlay) fogOverlay.setVisible(fogActive());
    if (currentTool !== 'fog') fogStroke = null;
    if (terrain) terrain.setBrush({ visible: false });
    updateHintBar();
}
function setBiome(key) {
    currentBiome = key;
    document.querySelectorAll('#biome-panel .biome-swatch').forEach(b =>
        b.classList.toggle('active', b.dataset.biome === key));
}
function setBrushMode(mode) {
    if (mode !== 'river') cancelRiverDraft();
    terrainBrush.mode = mode;
    document.querySelectorAll('#terrain-panel .brush-mode').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    updateHintBar();
}
function setBrushMaterial(i) {
    terrainBrush.material = i;
    document.querySelectorAll('#terrain-mats .mat-swatch').forEach(b => b.classList.toggle('active', +b.dataset.mat === i));
    if (terrainBrush.mode !== 'paint') setBrushMode('paint');
}
function setBrushRadius(r) {
    terrainBrush.radius = Math.max(1, Math.min(25, r));
    const input = document.getElementById('brush-radius');
    if (input) input.value = terrainBrush.radius;
    document.getElementById('brush-radius-val').textContent = terrainBrush.radius.toFixed(0);
    terrain.setBrush({ radius: terrainBrush.radius });
}
function emitWater() {
    if (socket) socket.emit('update-terrain', { water: terrain.getWaterData() });
    syncWaterControls();
}

function syncTerrainResetButton() {
    const button = document.getElementById('terrain-reset');
    if (button) button.disabled = !!pendingTerrainReset;
}

function requestTerrainReset() {
    if (!terrain || pendingTerrainReset) return;
    if (!socket || !socket.connected || !mapReload.authenticated) {
        alert('Reconnect before resetting terrain.');
        return;
    }
    const prompt = terrainIsUnified
        ? 'Reset edited terrain and water in this province?'
        : 'Reset all terrain and water on this pocket map?';
    if (!confirm(prompt)) return;

    const requestId = newStructureIdentity('terrain-reset');
    pendingTerrainReset = {
        requestId,
        beforeWater: structuredClone(terrain.getWaterData().bodies)
    };
    syncTerrainResetButton();
    socket.emit('reset-terrain', { requestId });
}

function applyTerrainResetResult(result = {}) {
    if (!terrain || !result || typeof result !== 'object') return;
    const pending = pendingTerrainReset && result.requestId === pendingTerrainReset.requestId
        ? pendingTerrainReset : null;
    const belongsHere = result.scope === 'map'
        ? result.contextKey === currentMapKey
        : result.scope === 'province' ? terrainIsUnified : true;
    if (!belongsHere) {
        if (pending) {
            pendingTerrainReset = null;
            syncTerrainResetButton();
        }
        return;
    }

    if (!pending) {
        terrain.applyData(result);
        syncWaterControls();
        applyBuildLevelVisibility();
        return;
    }

    const afterWater = Array.isArray(result.water?.bodies)
        ? structuredClone(result.water.bodies) : [];
    let patch = null;
    if (result.clear) {
        terrain.beginStroke();
        terrain.reset();
        patch = terrain.endStroke();
        if (result.water) terrain.setWaterData(result.water);
        // Preserve the existing pocket undo order: terrain first, then water.
        if (pending.beforeWater.length) {
            undoStack.push({ kind: 'water', before: pending.beforeWater, after: afterWater });
        }
        if (patch) undoStack.push({ kind: 'chunks', patch });
    } else {
        const chunks = result.chunks && typeof result.chunks === 'object' ? result.chunks : {};
        if (Object.keys(chunks).length) patch = terrain.applyPatch(chunks);
        // Applying a canonical server deletion marks local sync dirt; drain it
        // so a later brush stroke cannot accidentally re-emit the reset.
        terrain.collectDirtyPayload();
        if (result.water) terrain.setWaterData(result.water);
        if (patch) undoStack.push({ kind: 'chunks', patch });
        if (JSON.stringify(pending.beforeWater) !== JSON.stringify(afterWater)) {
            undoStack.push({ kind: 'water', before: pending.beforeWater, after: afterWater });
        }
    }
    while (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
    pendingTerrainReset = null;
    syncTerrainResetButton();
    syncWaterControls();
    applyBuildLevelVisibility();
}

function emitChunkPayloadBatches(keys, batchSize = 40) {
    if (!socket) return;
    for (let i = 0; i < keys.length; i += batchSize) {
        socket.emit('update-terrain', terrain.payloadForKeys(keys.slice(i, i + batchSize)));
    }
}

// Floors, stair treads and visible roofs are gameplay surfaces. Raycast them alongside the
// terrain and return the nearest visible support, excluding the object being
// dragged so a floor patch cannot support itself.
function pickSupportSurface(event, { exclude = null } = {}) {
    castFromPointer(event, { renderer, camera, raycaster, mouse });
    const structures = objects.filter(o => o !== exclude && o.visible &&
        ['floor', 'stair', 'roof'].includes(o.userData.objectType));
    const targets = [...structures];
    if (!buildCutawayState) {
        if (terrain && terrain.group.visible) targets.push(terrain.chunkGroup);
        targets.push(plane); // raycast anchor even when the renderer hides it at survey zoom
    }
    const hit = raycaster.intersectObjects(targets, true)[0];
    if (!hit) return null;
    let top = hit.object;
    while (top.parent && top.parent !== scene && top.parent !== worldGroup && top.parent !== terrain?.chunkGroup) top = top.parent;
    const object = objects.find(o => o === top) || null;
    return { point: sceneToWorld(hit.point), object };
}

// Pick against the actual terrain chunks on tactical maps (fall back to the flat
// plane elsewhere) so the brush lands where the cursor visually touches the ground.
// Returns TRUE world coordinates (scene hit + floating origin) — everything
// downstream (terrain API, socket emits) speaks world coords.
function pointerToGround(event) {
    castFromPointer(event, { renderer, camera, raycaster, mouse });
    const hit = (terrain && terrain.group.visible)
        ? raycaster.intersectObjects([terrain.chunkGroup, plane], true)[0]
        : raycaster.intersectObject(plane)[0];
    return hit ? sceneToWorld(hit.point) : null;
}
// Scene <-> world conversion at the raycast/camera boundary (floating origin).
function sceneToWorld(p) {
    return new THREE.Vector3(p.x + terrain.worldOrigin.x, p.y, p.z + terrain.worldOrigin.z);
}
function focusCameraOn(worldPos) {
    const tx = worldPos.x - terrain.worldOrigin.x;
    const tz = worldPos.z - terrain.worldOrigin.z;
    controls.target.set(tx, worldPos.y, tz);
    // When we're zoomed far out (a hex-lens altitude), placing/moving an object and
    // only recentering the orbit pivot does nothing visible — the object is a
    // sub-pixel dot thousands of units below. Descend to a tactical view of it so
    // you actually land next to what you placed. When already close (normal
    // editing/move), keep the current framing and just recenter.
    const TACTICAL_VIEW_DIST = 120;
    if (camera.position.distanceTo(controls.target) > TACTICAL_VIEW_DIST) {
        camera.position.set(tx + 8, worldPos.y + 12, tz + 8);
    }
}
function frameCameraOn(worldPos) {
    focusCameraOn(worldPos);
    camera.position.set(controls.target.x + 8, worldPos.y + 12, controls.target.z + 8);
}
// The effective brush mode for a dab: Shift inverts raise<->lower.
function effectiveBrushMode() {
    const m = terrainBrush.mode;
    if (shiftDown && m === 'raise') return 'lower';
    if (shiftDown && m === 'lower') return 'raise';
    return m;
}
function terrainDab(p) {
    const b = terrainBrush;
    const mode = effectiveBrushMode();
    if (mode === 'paint') terrain.paint(p.x, p.z, b.radius, b.strength, b.material);
    else terrain.sculpt(p.x, p.z, b.radius, b.strength, mode, strokeRef);
    lastDab = { x: p.x, z: p.z };
}
// Lay dabs at fixed spacing along the drag path so stroke intensity doesn't
// depend on mouse speed or frame rate.
function strokeTo(p) {
    if (!lastDab) { terrainDab(p); return; }
    const spacing = Math.max(0.4, terrainBrush.radius * 0.25);
    const dx = p.x - lastDab.x, dz = p.z - lastDab.z;
    const dist = Math.hypot(dx, dz);
    if (dist < spacing) return;
    // Pick jumped (fast flick, or the ray slipped off the terrain onto the far
    // ground plane): teleport instead of dragging a scar across the map.
    if (dist > Math.max(20, terrainBrush.radius * 4)) { terrainDab(p); return; }
    const steps = Math.min(64, Math.floor(dist / spacing));
    for (let s = 1; s <= steps; s++) {
        terrainDab({ x: lastDab.x + (dx * s) / steps, z: lastDab.z + (dz * s) / steps });
    }
}
// Move/tint the shader brush cursor (paint mode shows the selected material color).
function updateBrushCursor(p) {
    const mode = effectiveBrushMode();
    const color = mode === 'paint' ? MATERIALS[terrainBrush.material].color : BRUSH_COLORS[mode];
    terrain.setBrush({ x: p.x, z: p.z, radius: terrainBrush.radius, color, visible: true });
}
// Alt+click eyedropper: set the flatten target (and pick up the material in paint mode).
function sampleUnderCursor(p) {
    const h = terrain.sampleHeight(p.x, p.z);
    terrainBrush.flattenRef = h;
    const label = document.getElementById('flatten-target');
    if (label) label.textContent = h.toFixed(1);
    if (terrainBrush.mode === 'paint') {
        setBrushMaterial(terrain.dominantMaterial(p.x, p.z));
    }
}
function clearFlattenTarget() {
    terrainBrush.flattenRef = null;
    const label = document.getElementById('flatten-target');
    if (label) label.textContent = 'auto';
}
function updateRampPreview(p) {
    if (!rampStart) return;
    const pts = [
        new THREE.Vector3(rampStart.x, rampStart.h + 0.1, rampStart.z),
        new THREE.Vector3(p.x, terrain.sampleHeight(p.x, p.z) + 0.1, p.z)
    ];
    rampPreview.geometry.setFromPoints(pts);
    rampPreview.visible = true;
}
// --- Undo/redo (terrain strokes + water body edits; syncs what changed) ---
function undoTerrain() {
    if (!undoStack.length || !terrain) return;
    const entry = undoStack.pop();
    if (entry.kind === 'water') {
        terrain.setWaterData({ bodies: entry.before });
        emitWater();
        redoStack.push(entry); // redo re-applies entry.after
        return;
    }
    redoStack.push({ kind: 'chunks', patch: terrain.applyPatch(entry.patch) }); // inverse
    terrain.collectDirtyPayload();                  // drain; we encode the keys directly
    emitChunkPayloadBatches(Object.keys(entry.patch));
}
function redoTerrain() {
    if (!redoStack.length || !terrain) return;
    const entry = redoStack.pop();
    if (entry.kind === 'water') {
        terrain.setWaterData({ bodies: entry.after });
        emitWater();
        undoStack.push(entry);
        return;
    }
    undoStack.push({ kind: 'chunks', patch: terrain.applyPatch(entry.patch) });
    terrain.collectDirtyPayload();
    emitChunkPayloadBatches(Object.keys(entry.patch));
}
// --- Status hint bar: always tell the user what the mouse does right now ---
function updateHintBar() {
    const bar = document.getElementById('hint-bar');
    if (!bar) return;
    const cam = 'RMB orbit · MMB pan · wheel zoom';
    let hint;
    if (pendingAttack || pendingSpell) {
        hint = `Combat · pick a target — LMB click a token · Esc cancel · ${cam}`;
    } else if (terrainActive()) {
        const mode = terrainBrush.mode;
        if (mode === 'lake') {
            hint = `Water · lake — LMB pour · drag up/down = level · Alt+click delete · Ctrl+Z undo · ${cam}`;
        } else if (mode === 'river') {
            hint = `Water · river — LMB add waypoint · Enter/double-click finish · Esc cancel · Alt+click delete · ${cam}`;
        } else {
            const verb = mode === 'ramp' ? 'LMB drag ramp line' : mode === 'paint' ? 'LMB paint' : 'LMB sculpt';
            hint = `Terrain · ${mode} — ${verb} · Shift invert · Alt+click sample · [ ] size · 1-0 modes · Ctrl+Z undo · ${cam}`;
        }
    } else if (currentTool === 'terrain') {
        hint = `Biomes — LMB paint hex · Alt+click clear · tagged hexes seed new tactical maps · ${cam}`;
    } else if (currentTool === 'build' && isTacticalKey()) {
        const m = buildBrush.mode;
        const level = buildLevelName();
        hint = buildBrush.buildingPickMode === 'pick'
            ? `Build · pick building — click a grouped structure · legacy pieces require Adopt piece · Esc cancel · ${cam}`
            : buildBrush.buildingPickMode === 'adopt'
            ? `Build · adopt piece — click exactly one structure to join building ${shortBuildingId(buildBrush.buildingId)} · Esc cancel · ${cam}`
            : buildBrush.pickingLevel
            ? `Build · pick level — click terrain, a floor, stairs, or a roof · Esc cancel · ${cam}`
            : m === 'erase'
            ? `Build · erase — LMB cuts one wall, floor, or roof cell · stairs delete whole · Alt+click removes whole structure · ${cam}`
            : m === 'tile'
                ? `Build · ${buildBrush.tileKind === 'gap' ? 'cut' : 'restore'} tiles — LMB edits one floor or roof cell · Alt+click removes whole structure · ${cam}`
            : m === 'opening'
                ? `Build · ${buildBrush.openingKind} · ${level} — LMB edit one wall cell · Alt+click removes whole run · ${cam}`
            : m === 'wall'
                ? `Build · wall · ${level} — drag, then turn once for an L · Page Up/Down level · Alt+click erase · ${cam}`
                : m === 'stair'
                    ? `Build · stairs ${buildBrush.stairDirection > 0 ? 'up' : 'down'} · ${level} — drag through cells · Page Up/Down level · ${cam}`
                    : m === 'roof'
                        ? `Build · ${buildBrush.roofShape} roof over ${level} — drag a cover rectangle · isolate ${level} to see inside · ${cam}`
                        : `Build · floor · ${level} — drag a tile rectangle · Page Up/Down level · Alt+click erase · ${cam}`;
    } else if (currentTool === 'build') {
        hint = `Build works on tactical maps — enter a province leaf or pocket first · ${cam}`;
    } else if (fogActive()) {
        hint = `Fog · ${fogBrush.mode} — LMB drag to paint 1-mile hexes · players only receive revealed regions · ${cam}`;
    } else if (currentTool === 'fog') {
        hint = `Fog works on the unified world — leave the pocket first · ${cam}`;
    } else if (currentTool === 'view') {
        const who = viewCtl.target === 'all' ? 'all players' : viewCtl.target;
        hint = viewCtl.action === 'token'
            ? `View · token — LMB click a token to frame it for ${who} · panel: bring / lock / release · ${cam}`
            : `View · point — LMB click the ground to send ${who} there · panel: bring / lock / release · ${cam}`;
    } else if (selectedObject && currentTool == null) {
        hint = `${objectIdentity(selectedObject, objects).displayName} selected · inspector: edit / duplicate / encounter · . focus · Del delete · Esc clear · ${cam}`;
    } else if (currentTool === 'move') {
        hint = `Move — LMB select, LMB ground to drop · Del delete · ${cam}`;
    } else if (currentTool === 'ruler') {
        hint = `Ruler — LMB add point · right-CLICK restart · Esc cancel · ${cam}`;
    } else if (currentTool === 'add') {
        hint = `Add — LMB place object · ${cam}`;
    } else {
        hint = `${cam} · double-click hex/portal to travel`;
    }
    bar.textContent = hint;
}
// Ground height a token should rest at, for the current map.
function groundY(x, z, halfHeight, supportY = null) {
    const base = Number.isFinite(supportY)
        ? supportY
        : (terrain && isTacticalKey()) ? terrain.sampleHeight(x, z) : 0;
    return base + halfHeight;
}

// LOD (U3): on the unified world, nested lit 3D rings render UNDER the fine
// chunks and coarsen outward — zooming out just reveals more 3D world, no mode
// switch. Fog scales with zoom for depth cueing. Pockets stay detail-only.
function updateTerrainLOD() {
    // Floating origin: slide the world under the camera when it wanders too far
    // for float32. Deferred while a gesture is mid-flight so a stroke never
    // spans a rebase frame.
    if (terrainIsUnified && !isSculpting && !lakeDrag && !rampStart) {
        maybeRebaseWorld({ terrain, worldGroup, camera, controls });
    }
    const dist = camera.position.distanceTo(controls.target);
    // Wheel zoom spans grass level to lens altitude — five orders of magnitude.
    // A constant zoom speed makes that trip take hundreds of ticks; scale the
    // speed with distance (log) so high-altitude ticks cover real ground while
    // close-up stays precise.
    controls.zoomSpeed = Math.min(4, Math.max(1, 0.8 + Math.log10(Math.max(1, dist / 25))));
    // Frustum follows zoom: hex-tier lenses sit hundreds of thousands of units
    // up, tactical work needs near=0.1. Scale both ends (only on real change —
    // updateProjectionMatrix isn't free) so depth precision stays healthy.
    const near = Math.max(0.1, Math.min(2000, dist * 0.002));
    const far = Math.max(40000, dist * 8);
    if (near < camera.near * 0.7 || near > camera.near * 1.4 ||
        far > camera.far * 1.4 || far < camera.far * 0.7) {
        camera.near = near; camera.far = far;
        camera.updateProjectionMatrix();
    }
    // The backdrop plane doubles as the ground-pick target (hex descend, biome
    // paint, ruler). It's 2000u of geometry — scale it with zoom so rays from
    // any screen point still land on it at hex-lens altitudes.
    plane.scale.setScalar(Math.max(1, (dist * 3) / 2000));
    // Grid is a close-up tactical tool: full only when near enough to place
    // tokens, gone by the time you're surveying (the default landing view).
    terrain.setGridFade(1 - Math.max(0, Math.min(1, (dist - 15) / (40 - 15))));
    // Terrain streaming/LOD centers are world coords; the camera target is scene.
    const worldTarget = { x: controls.target.x + terrain.worldOrigin.x,
                          z: controls.target.z + terrain.worldOrigin.z };
    terrain.updateWindow(worldTarget);
    if (terrainIsUnified) {
        terrain.setLODVisible(true);
        terrain.setOceanEnabled(true);
        terrain.updateLODRings(worldTarget);
        plane.visible = false;                    // rings are the ground everywhere
        scene.fog.near = Math.max(FOG_NEAR, dist * 1.5);
        scene.fog.far = Math.max(FOG_FAR, dist * 6);
    } else {
        terrain.setLODVisible(false);
        terrain.setOceanEnabled(false);           // pockets dig below sea level dry
        scene.fog.near = FOG_NEAR;
        scene.fog.far = FOG_FAR;
    }
    const vegetationVisible = terrainIsUnified && !buildCutawayState;
    if (grass) grass.update(camera, controls, vegetationVisible);
    if (trees) trees.update(camera, controls, vegetationVisible);
    if (fogOverlay) fogOverlay.update(fogMask, worldTarget.x, worldTarget.z, dist);
}
// Reflect the current water bodies in the panel (count readout).
function syncWaterControls() {
    if (!terrain) return;
    const el = document.getElementById('water-body-count');
    if (el) el.textContent = String(terrain.water.bodies.length);
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

// --- Init ---
try {
    init();
} catch (e) {
    console.error('Fatal Error on Init:', e);
}

// SRD rules data, used only to derive combat stats for character combatants.
loadSRD().then(srd => {
    SRD = srd;
    if (pendingHomebrew) SRD.setHomebrew(pendingHomebrew);
    answerStatsPending(); // combat may have arrived before the SRD finished loading
}).catch(e => console.error('SRD load failed (combat stat auto-fill disabled):', e));

// The 1.3 MB bestiary is fetched on first Library/search interaction by
// ensureMonsterLibraryLoaded(), keeping initial tabletop startup lean.
