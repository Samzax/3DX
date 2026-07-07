// gm.js — GM screen (/gm): three-layer map navigation (World → Region → Tactical),
// object placement, terrain sculpting/painting/water, rulers, and Socket.IO sync.
// Scene boilerplate, meshes and the ruler tool live in ../shared/.

import * as THREE from 'three';
import { Terrain, MATERIALS } from '../shared/terrain.js';
import { createTabletopScene, startRenderLoop, castFromPointer, snapToGrid, trackRightDrag, styleGroundForTerrain, buildBoundsRect, updateWorldFollow, FOG_NEAR, FOG_FAR, GRID_CELL_SIZE } from '../shared/scene.js';
import { defaultMaterial, selectedMaterial, buildObjectFromData, applyMove } from '../shared/models.js';
import { RulerTool } from '../shared/rulers.js';
import { bindLongPress, dismissSubmenusOnOutsideClick } from '../shared/ui.js';

// --- Terrain editor state (tactical layer only) ---
let terrain = null;
let isSculpting = false;
let strokeRef = 0;                         // flatten target captured at stroke start
let lastDab = null;                        // last dab position, for fixed-spacing strokes
let shiftDown = false;                     // Shift inverts raise<->lower while held
const terrainBrush = { mode: 'raise', radius: 6, strength: 0.35, material: 0, flattenRef: null };

// Undo/redo: copy-on-write patches of only the chunks each stroke touched.
const UNDO_LIMIT = 20;
const undoStack = [], redoStack = [];

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

let wasRightDrag = null;                   // set in init(); see trackRightDrag

let scene, camera, renderer, controls, plane, grid, raycaster, mouse, dirLight;
let ruler;
let objects = [];
let selectedObject = null;
let selectedObjectType = null;
let selectedObjectData = null;
let menuButtons = {};

let socket;

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
let hexFillGroup = null;            // colored hex fill overlay

const SQRT3 = Math.sqrt(3);
const HEX_SIZE = 2;            // world units (circumradius) used to draw hexes
const HEX_MAP_RADIUS = 6;      // hex field radius, in hexes
const TACTICAL_DEPTH = 3;      // depth of the square-grid leaf
// DMG p14 hex scales per depth (hex layers only).
const HEX_SCALES = {
    0: { miles: 60, label: 'Continent' },
    1: { miles: 6,  label: 'Kingdom' },
    2: { miles: 1,  label: 'Province' }
};

const hexLineMaterial = new THREE.LineBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.5 });

function mapDepth(key) { return key.split('/').length - 1; }      // 0..2 hex layers, 3 tactical
function isPocket(key = currentMapKey) { return key.startsWith('pocket/'); }
// Square-grid maps with editable terrain: hex-tree leaves and pocket dungeons.
function isTacticalKey(key = currentMapKey) { return isPocket(key) || mapDepth(key) >= TACTICAL_DEPTH; }
function isHexLayer(depth = mapDepth(currentMapKey)) { return !isPocket(currentMapKey) && depth < TACTICAL_DEPTH; }

// --- Pointy-top axial hex math on the XZ ground plane ---
function hexToWorld(q, r) {
    return { x: HEX_SIZE * SQRT3 * (q + r / 2), z: HEX_SIZE * 1.5 * r };
}
function roundHex(qf, rf) { // cube rounding
    let xf = qf, zf = rf, yf = -qf - rf;
    let rx = Math.round(xf), ry = Math.round(yf), rz = Math.round(zf);
    const dx = Math.abs(rx - xf), dy = Math.abs(ry - yf), dz = Math.abs(rz - zf);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy > dz) ry = -rx - rz;
    else rz = -rx - ry;
    return { q: rx, r: rz };
}
function worldToHex(x, z) {
    return roundHex((SQRT3 / 3 * x - 1 / 3 * z) / HEX_SIZE, (2 / 3 * z) / HEX_SIZE);
}
function hexDistance(a, b) {
    return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}
function hexInField(q, r) {
    return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= HEX_MAP_RADIUS;
}
function hexCorner(cx, cz, i) {
    const ang = Math.PI / 180 * (60 * i - 30); // pointy-top corners
    return new THREE.Vector3(cx + HEX_SIZE * Math.cos(ang), 0.02, cz + HEX_SIZE * Math.sin(ang));
}
function buildHexGrid() {
    const positions = [];
    for (let q = -HEX_MAP_RADIUS; q <= HEX_MAP_RADIUS; q++) {
        for (let r = -HEX_MAP_RADIUS; r <= HEX_MAP_RADIUS; r++) {
            if (!hexInField(q, r)) continue;
            const { x, z } = hexToWorld(q, r);
            const c = [];
            for (let i = 0; i < 6; i++) c.push(hexCorner(x, z, i));
            for (let i = 0; i < 6; i++) {
                const a = c[i], b = c[(i + 1) % 6];
                positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
            }
        }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const group = new THREE.Group();
    group.add(new THREE.LineSegments(geom, hexLineMaterial));
    return group;
}
function showLayerGrid(key) {
    // The square grid is drawn in the terrain shader now; keep the old mesh off.
    if (grid) grid.visible = false;
    if (hexGridGroup) {
        scene.remove(hexGridGroup);
        hexGridGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); });
        hexGridGroup = null;
    }
    if (!isPocket(key) && mapDepth(key) < TACTICAL_DEPTH) {
        hexGridGroup = buildHexGrid();
        scene.add(hexGridGroup);
    }
}

// Colored fills for biome-tagged hexes (hex layers only).
function rebuildHexFills() {
    if (hexFillGroup) {
        scene.remove(hexFillGroup);
        hexFillGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
        hexFillGroup = null;
    }
    if (!isHexLayer()) return;
    hexFillGroup = new THREE.Group();
    for (const hk of Object.keys(hexTags)) {
        const biome = BIOMES[hexTags[hk].biome];
        if (!biome) continue;
        const [q, r] = hk.split(',').map(Number);
        const { x, z } = hexToWorld(q, r);
        const shape = new THREE.Shape();
        for (let i = 0; i < 6; i++) {
            const c = hexCorner(x, z, i);
            if (i === 0) shape.moveTo(c.x, c.z); else shape.lineTo(c.x, c.z);
        }
        const geo = new THREE.ShapeGeometry(shape);
        geo.rotateX(Math.PI / 2); // shape XY -> ground XZ
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
            color: biome.color, transparent: true, opacity: 0.35, side: THREE.DoubleSide
        }));
        mesh.position.y = 0.012; // under the grid lines
        hexFillGroup.add(mesh);
    }
    scene.add(hexFillGroup);
}

// --- Layer-aware snapping & measurement ---
function snapToCurrentGrid(point) {
    if (isHexLayer()) {
        const h = worldToHex(point.x, point.z);
        const c = hexToWorld(h.q, h.r);
        return new THREE.Vector3(c.x, point.y, c.z);
    }
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
    currentMapKey = key;
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
    document.querySelectorAll('#object-menu .menu-button').forEach(b => b.classList.remove('active'));
    // clear local scene; server repopulates via 'map-state' after join-map
    objects.forEach(o => scene.remove(o));
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
        while (top.parent && top.parent !== scene) top = top.parent;
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
    const h = worldToHex(hit.point.x, hit.point.z);
    descendInto(h.q, h.r);
}

// --- Socket.IO: GM auto-login + full map/character sync ---
function initSocket() {
    socket = io();

    socket.on('connect', () => {
        console.log('Conectado ao servidor com ID:', socket.id);
        // Auto-login as GM on this single connection
        socket.emit('login', 'GM');
        sessionStorage.setItem('vtt_username', 'GM');
        // Reconnects auto-join 'world' server-side; come back to where we were.
        if (currentMapKey !== 'world') socket.emit('join-map', { key: currentMapKey });
    });

    socket.on('login-success', (userData) => {
        console.log('GM logged in:', userData);
        const loginOverlay = document.getElementById('login-overlay');
        if (loginOverlay) loginOverlay.classList.add('hidden');
    });

    socket.on('load-user-characters', (characters) => {
        loadCharactersToMenu(characters);
    });

    socket.on('character-updated', () => {
        socket.emit('get-characters'); // Refresh the menu
    });

    // Full map state on connect / map switch
    socket.on('map-state', (data) => {
        // Ignore states for maps we're not on (e.g. the automatic 'world' join
        // that precedes our re-join after a reconnect).
        if (data.key && data.key !== currentMapKey) return;
        objects.forEach(obj => scene.remove(obj));
        objects = [];
        ruler.removeSegments();

        data.objects.forEach(objData => createObjectFromData(objData.id, objData));
        data.rulers.forEach(rulerData => ruler.addFromData(rulerData.id, rulerData));

        // Biome tags for this map's hexes (hex layers only render them).
        hexTags = data.hexes || {};
        rebuildHexFills();

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
            if (data.unified) {
                // One continuous world: load it once, then just fly the camera
                // between provinces (no reload flash, no re-applying 1000s of
                // chunks every hop).
                if (!terrainIsUnified) {
                    terrain.reset();
                    undoStack.length = 0; redoStack.length = 0;
                    if (data.terrain) terrain.applyData(data.terrain);
                    terrainIsUnified = true;
                }
                terrain.group.visible = true;
                styleGroundForTerrain(plane, true);
                syncWaterControls();
                if (data.worldCenter) {
                    const c = data.worldCenter;   // fly to this province's spot in the world
                    controls.target.set(c.x, 0, c.z);
                    camera.position.set(c.x + 20, 30, c.z + 20);
                }
            } else {
                // Hex tiers (no terrain) or a pocket (its own separate terrain).
                terrainIsUnified = false;
                terrain.reset();
                undoStack.length = 0; redoStack.length = 0;
                if (data.terrain) terrain.applyData(data.terrain);
                const tactical = isTacticalKey(currentMapKey);
                terrain.group.visible = tactical;
                styleGroundForTerrain(plane, tactical);
                syncWaterControls();
            }
        }
    });

    // Live terrain edits (echo to other GM tabs; players handle this too).
    socket.on('terrain-updated', (data) => {
        if (terrain) { terrain.applyData(data); syncWaterControls(); }
    });

    // Live hex tag edits (echo to this and other GM tabs in the room).
    socket.on('hex-updated', ({ hex, biome }) => {
        if (biome) hexTags[hex] = { biome };
        else delete hexTags[hex];
        rebuildHexFills();
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
            scene.remove(object);
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

    socket.on('disconnect', () => {
        console.log('Desconectado do servidor.');
    });
}

function init() {
    ({ scene, camera, renderer, controls, plane, grid, raycaster, mouse, dirLight } =
        createTabletopScene(document.getElementById('scene-container')));

    // Tactical terrain (heightmap + material paint + water). Hidden off-tactical.
    // The brush cursor is drawn by the terrain shader (terrain.setBrush).
    terrain = new Terrain();
    terrain.group.visible = false;
    scene.add(terrain.group);

    // Ramp gesture preview: a line from the anchor to the cursor while dragging.
    rampPreview = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color: 0xff9ff3, transparent: true, opacity: 0.9 })
    );
    rampPreview.visible = false;
    scene.add(rampPreview);

    // River draft preview: waypoints + cursor as a light-blue polyline.
    riverPreview = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color: 0x7ad7ff, transparent: true, opacity: 0.9 })
    );
    riverPreview.visible = false;
    scene.add(riverPreview);

    wasRightDrag = trackRightDrag(renderer.domElement);

    ruler = new RulerTool({
        scene,
        tooltip: document.getElementById('ruler-tooltip'),
        measure: (points) => isHexLayer() ? measurePath(points) : null
    });

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
    // Characters are loaded from the server via Socket.IO (see initSocket).

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
    document.getElementById('terrain-reset').addEventListener('click', () => {
        if (!confirm('Reset all terrain and water on this tactical map?')) return;
        const waterBefore = terrain.getWaterData().bodies;
        terrain.beginStroke();
        terrain.reset();
        const patch = terrain.endStroke();
        // Two undo entries (water first, chunks second): Ctrl+Z restores the
        // terrain, a second Ctrl+Z restores the water bodies.
        if (waterBefore.length) undoStack.push({ kind: 'water', before: waterBefore, after: [] });
        if (patch) undoStack.push({ kind: 'chunks', patch });
        while (undoStack.length > UNDO_LIMIT) undoStack.shift();
        redoStack.length = 0;
        if (socket) socket.emit('update-terrain', { clear: true, water: terrain.getWaterData() });
    });

    const flattenBtn = document.getElementById('flatten-target');
    if (flattenBtn) flattenBtn.addEventListener('click', clearFlattenTarget);

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
            if (!terrain) return;
            terrain.tick(performance.now() / 1000);                       // water animation
            if (terrain.group.visible) updateTerrainLOD();                 // detailed chunks vs summary
        }
    });
    // Debug handle for console/tooling inspection (visual bisection etc).
    window.__dbg = { terrain, scene, camera, controls, plane, grid };
    initSocket();
}

function onPointerDown(event) {
    // The left button belongs to tools; right/middle belong to the camera (OrbitControls).
    if (event.button !== 0) return;

    if (isDraggingHeight) {
        isDraggingHeight = false;
        deselectObject();
        return;
    }

    // Terrain tool on a hex layer = biome painting (Alt+click clears the tag).
    if (currentTool === 'terrain' && isHexLayer()) {
        castFromPointer(event, { renderer, camera, raycaster, mouse });
        const hit = raycaster.intersectObject(plane)[0];
        if (!hit) return;
        const h = worldToHex(hit.point.x, hit.point.z);
        if (!hexInField(h.q, h.r)) return;
        socket.emit('update-hex', { q: h.q, r: h.r, biome: event.altKey ? null : currentBiome });
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
    const allObjects = [plane, ...objects];
    const intersects = raycaster.intersectObjects(allObjects, true);
    if (intersects.length === 0) return;

    const firstIntersect = intersects[0];
    let topLevelObject = firstIntersect.object;
    while (topLevelObject.parent && topLevelObject.parent !== scene) {
        topLevelObject = topLevelObject.parent;
    }
    const clickedObject = objects.find(obj => obj === topLevelObject);

    if (clickedObject) {
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
    } else if (firstIntersect.object.name === "tabletop") {
        const intersectPoint = firstIntersect.point;
        const snappedPosition = snapToCurrentGrid(intersectPoint);

        switch (currentTool) {
            case 'move':
                if (selectedObject) {
                    const docId = selectedObject.userData.syncId;
                    if (docId) {
                        const finalPosition = snapToCurrentGrid(selectedObject.position);
                        socket.emit('move-object', {
                            id: docId,
                            position: {
                                x: finalPosition.x,
                                y: selectedObject.position.y, // keep current height
                                z: finalPosition.z
                            }
                        });
                    }
                    controls.target.copy(selectedObject.position);
                    deselectObject();
                }
                break;
            case 'add':
                if (selectedObjectType) {
                    addObject(snappedPosition);
                    controls.target.copy(snappedPosition);
                    deselectObjectType();
                }
                break;
            case 'ruler':
                ruler.click(getCurrentRulerSnap(intersectPoint), emitRuler);
                break;
        }
    }
}

function onPointerMove(event) {
    ruler.trackMouse(event);

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
    const intersectPoint = intersects[0].point;

    if (currentTool === 'move' && selectedObject) {
        applyMove(selectedObject, snapToCurrentGrid(intersectPoint), currentMoveMode,
            (x, z, halfHeight) => groundY(x, z, halfHeight));
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
    castFromPointer(event, { renderer, camera, raycaster, mouse });
    const intersects = raycaster.intersectObject(plane);
    if (intersects.length > 0) {
        ruler.restartAt(getCurrentRulerSnap(intersects[0].point), emitRuler);
    }
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
        event.shiftKey ? redoTerrain() : undoTerrain();
        return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redoTerrain();
        return;
    }

    // Terrain hotkeys: [ ] brush size, 1-8 brush modes.
    if (terrainActive()) {
        if (event.key === '[') { setBrushRadius(terrainBrush.radius - 1); return; }
        if (event.key === ']') { setBrushRadius(terrainBrush.radius + 1); return; }
        const mode = BRUSH_MODE_KEYS[event.key];
        if (mode) { setBrushMode(mode); return; }
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
        if (riverDraft) {
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
function addObject(position) {
    let halfHeight = 0.5;
    let dataToSave = {};

    switch (selectedObjectType) {
        case 'token':
            halfHeight = 0.1;
            dataToSave = { type: 'token', color: 0xdd4444 };
            break;
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
                position: { x: position.x, y: groundY(position.x, position.z, 0), z: position.z }
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

    // Seat the object on the terrain surface (flat y=0 off the tactical layer).
    dataToSave.position = { x: position.x, y: groundY(position.x, position.z, halfHeight), z: position.z };
    socket.emit('add-object', dataToSave);
}

function createObjectFromData(id, data) {
    const mesh = buildObjectFromData(id, data);
    if (mesh) {
        scene.add(mesh);
        objects.push(mesh);
    }
}

function selectObject(object) {
    deselectObject();
    selectedObject = object;
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
}

// --- UI Management (Right Menu) ---
function setSelectedObjectType(type, data = null) {
    if (selectedObjectType === type && selectedObjectData === data) {
        deselectObjectType();
    } else {
        selectedObjectType = type;
        selectedObjectData = data;
        setTool('add');

        document.querySelectorAll('#object-menu .menu-button').forEach(btn => {
            btn.classList.remove('active');
        });
        if (type === 'character') {
            const charBtn = document.querySelector(`button[data-char-id="${data.id}"]`);
            if (charBtn) charBtn.classList.add('active');
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
    document.querySelectorAll('#object-menu .menu-button').forEach(btn => {
        btn.classList.remove('active');
    });
}

function loadCharactersToMenu(characters) {
    const listContainer = document.getElementById('character-button-list');
    listContainer.innerHTML = '';

    if (!Array.isArray(characters) || characters.length === 0) {
        listContainer.innerHTML = '<p style="font-size: 12px; color: #999;">No characters found. Create one in the Character Creator!</p>';
        return;
    }

    characters.forEach(char => {
        const charBtn = document.createElement('button');
        charBtn.className = 'menu-button';
        charBtn.textContent = `Char: ${char.name}`;
        charBtn.title = `${char.name} - ${char.race}`;
        charBtn.style.color = char.color;
        charBtn.style.fontWeight = 'bold';
        charBtn.style.borderLeft = `5px solid ${char.color}`;
        charBtn.dataset.charId = char.id;
        charBtn.addEventListener('click', () => {
            setSelectedObjectType('character', char);
        });
        listContainer.appendChild(charBtn);
    });
}

// --- UI Management (Left Menu) ---
function setTool(toolName) {
    if (currentTool === 'ruler' && toolName !== 'ruler') {
        ruler.clearAll(() => socket.emit('clear-rulers'));
    }
    if (toolName !== 'ruler') {
        ruler.hideTooltip();
    }
    currentTool = toolName;
    if (toolName !== 'add' && toolName !== null) {
        deselectObjectType();
    }
    for (const key in toolMenuButtons) {
        toolMenuButtons[key].classList.toggle('active', key === toolName);
    }
    updateTerrainPanel();
}

// --- Terrain editor logic ---
function terrainActive() { return currentTool === 'terrain' && isTacticalKey(); }
function updateTerrainPanel() {
    const panel = document.getElementById('terrain-panel');
    const show = currentTool === 'terrain' && isTacticalKey();
    panel.classList.toggle('hidden', !show);
    // On hex layers the same tool paints biomes instead.
    const biomePanel = document.getElementById('biome-panel');
    if (biomePanel) biomePanel.classList.toggle('hidden', !(currentTool === 'terrain' && isHexLayer()));
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
// Pick against the actual terrain chunks on tactical maps (fall back to the flat
// plane elsewhere) so the brush lands where the cursor visually touches the ground.
function pointerToGround(event) {
    castFromPointer(event, { renderer, camera, raycaster, mouse });
    const hit = (terrain && terrain.group.visible)
        ? raycaster.intersectObjects([terrain.chunkGroup, plane], true)[0]
        : raycaster.intersectObject(plane)[0];
    return hit ? hit.point : null;
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
    if (socket) socket.emit('update-terrain', terrain.payloadForKeys(Object.keys(entry.patch)));
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
    if (socket) socket.emit('update-terrain', terrain.payloadForKeys(Object.keys(entry.patch)));
}
// --- Status hint bar: always tell the user what the mouse does right now ---
function updateHintBar() {
    const bar = document.getElementById('hint-bar');
    if (!bar) return;
    const cam = 'RMB orbit · MMB pan · wheel zoom';
    let hint;
    if (terrainActive()) {
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
function groundY(x, z, halfHeight) {
    const base = (terrain && isTacticalKey()) ? terrain.sampleHeight(x, z) : 0;
    return base + halfHeight;
}

// LOD (U3): on the unified world, nested lit 3D rings render UNDER the fine
// chunks and coarsen outward — zooming out just reveals more 3D world, no mode
// switch. Fog scales with zoom for depth cueing. Pockets stay detail-only.
function updateTerrainLOD() {
    const dist = camera.position.distanceTo(controls.target);
    // Grid is a close-up tactical tool: full only when near enough to place
    // tokens, gone by the time you're surveying (the default landing view).
    terrain.setGridFade(1 - Math.max(0, Math.min(1, (dist - 15) / (40 - 15))));
    terrain.updateWindow(controls.target);
    if (terrainIsUnified) {
        terrain.setLODVisible(true);
        terrain.setOceanEnabled(true);
        terrain.updateLODRings(controls.target);
        plane.visible = false;                    // rings are the ground everywhere
        scene.fog.near = Math.max(FOG_NEAR, dist * 1.5);
        scene.fog.far = Math.max(FOG_FAR, dist * 6);
    } else {
        terrain.setLODVisible(false);
        terrain.setOceanEnabled(false);           // pockets dig below sea level dry
        scene.fog.near = FOG_NEAR;
        scene.fog.far = FOG_FAR;
    }
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
