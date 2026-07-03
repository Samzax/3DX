// gm.js — GM screen (/gm): three-layer map navigation (World → Region → Tactical),
// object placement, terrain sculpting/painting/water, rulers, and Socket.IO sync.
// Scene boilerplate, meshes and the ruler tool live in ../shared/.

import * as THREE from 'three';
import { Terrain } from '../shared/terrain.js';
import { createTabletopScene, startRenderLoop, castFromPointer, snapToGrid, GRID_CELL_SIZE } from '../shared/scene.js';
import { defaultMaterial, selectedMaterial, buildObjectFromData, applyMove } from '../shared/models.js';
import { RulerTool } from '../shared/rulers.js';
import { bindLongPress, dismissSubmenusOnOutsideClick } from '../shared/ui.js';

// --- Terrain editor state (tactical layer only) ---
let terrain = null;
let terrainBrushRing = null;
let isSculpting = false;
let strokeRef = 0;                         // flatten target captured at stroke start
let strokeChanged = { heights: false, splat: false };
const terrainBrush = { mode: 'raise', radius: 6, strength: 0.35, material: 0 };

let scene, camera, renderer, controls, plane, grid, raycaster, mouse;
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

// ===== Three-layer map (World -> Region -> Tactical) =====
// A map is identified by a path key:
//   "world"            depth 0  -> hex grid, 90 km per hex
//   "world/q,r"        depth 1  -> hex grid, 9 km per hex
//   "world/q,r/q,r"    depth 2  -> square grid, 5 ft per cell (tactical)
let currentMapKey = 'world';
let hexGridGroup = null;

const SQRT3 = Math.sqrt(3);
const HEX_SIZE = 2;            // world units (circumradius) used to draw hexes
const HEX_MAP_RADIUS = 6;      // hex field radius, in hexes
const KM_PER_HEX = { 0: 90, 1: 9 }; // depth -> km label per hex

const hexLineMaterial = new THREE.LineBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.5 });

function mapDepth(key) { return key.split('/').length - 1; }      // 0 world, 1 region, 2 tactical
function isHexLayer(depth = mapDepth(currentMapKey)) { return depth < 2; }

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
function showLayerGrid(depth) {
    if (grid) grid.visible = (depth === 2);     // square grid only on tactical
    if (hexGridGroup) {
        scene.remove(hexGridGroup);
        hexGridGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); });
        hexGridGroup = null;
    }
    if (depth < 2) {
        hexGridGroup = buildHexGrid();
        scene.add(hexGridGroup);
    }
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
    // hex layers: sum of hex steps * km per hex
    const km = KM_PER_HEX[mapDepth(currentMapKey)] || 0;
    let steps = 0;
    for (let i = 0; i < points.length - 1; i++) {
        steps += hexDistance(worldToHex(points[i].x, points[i].z), worldToHex(points[i + 1].x, points[i + 1].z));
    }
    return { value: steps * km, unit: 'km' };
}

const emitRuler = (data) => socket.emit('add-ruler', data);

// --- Drill-down navigation ---
function enterMap(key) {
    currentMapKey = key;
    if (selectedObject) deselectObject();
    ruler.clearInProgress();
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
    showLayerGrid(mapDepth(key));
    // Hide terrain + its panel off the tactical leaf; map-state will repopulate it.
    if (terrain) terrain.group.visible = false;
    if (plane) plane.visible = (mapDepth(key) !== 2); // restored/hidden again by map-state
    isSculpting = false;
    if (terrainBrushRing) terrainBrushRing.visible = false;
    updateTerrainPanel();
    updateBreadcrumb();
    if (socket) socket.emit('join-map', { key });
}
function goUp() {
    if (mapDepth(currentMapKey) <= 0) return;
    enterMap(currentMapKey.split('/').slice(0, -1).join('/'));
}
function descendInto(q, r) {
    if (mapDepth(currentMapKey) >= 2) return; // tactical is the leaf
    if (!hexInField(q, r)) return;
    enterMap(`${currentMapKey}/${q},${r}`);
}
function updateBreadcrumb() {
    const bc = document.getElementById('breadcrumb');
    const up = document.getElementById('btn-up');
    if (!bc) return;
    const segs = currentMapKey.split('/');
    const labels = ['World'];
    for (let i = 1; i < segs.length; i++) labels.push((i === 1 ? 'Region' : 'Tactical') + ' (' + segs[i] + ')');
    const depth = mapDepth(currentMapKey);
    const scale = depth === 0 ? 'each hex = 90 km' : depth === 1 ? 'each hex = 9 km' : 'each square = 5 ft';
    bc.textContent = labels.join('  ›  ') + '   —   ' + scale;
    if (up) up.disabled = (depth === 0);
}
function onDoubleClick(event) {
    if (mapDepth(currentMapKey) >= 2) return;
    if (currentTool === 'add' || currentTool === 'move' || currentTool === 'ruler') return;
    castFromPointer(event, { renderer, camera, raycaster, mouse });
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
        objects.forEach(obj => scene.remove(obj));
        objects = [];
        ruler.removeSegments();

        data.objects.forEach(objData => createObjectFromData(objData.id, objData));
        data.rulers.forEach(rulerData => ruler.addFromData(rulerData.id, rulerData));

        // Terrain: rebuild from the stored blob; visible only on the tactical leaf.
        if (terrain) {
            terrain.reset();
            if (data.terrain) terrain.applyData(data.terrain);
            const tactical = mapDepth(currentMapKey) === 2;
            terrain.group.visible = tactical;
            // The terrain mesh is the ground on tactical maps; hide the flat
            // tabletop so dug (negative) terrain isn't masked by it. The plane
            // is invisible but still raycast for XZ picking.
            if (plane) plane.visible = !tactical;
            syncWaterControls();
        }
    });

    // Live terrain edits (echo to other GM tabs; players handle this too).
    socket.on('terrain-updated', (data) => {
        if (terrain) { terrain.applyData(data); syncWaterControls(); }
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
    ({ scene, camera, renderer, controls, plane, grid, raycaster, mouse } =
        createTabletopScene(document.getElementById('scene-container')));

    // Tactical terrain (heightmap + material paint + water). Hidden off-tactical.
    terrain = new Terrain();
    terrain.group.visible = false;
    scene.add(terrain.group);
    // Brush-radius indicator that follows the cursor while the terrain tool is active.
    terrainBrushRing = new THREE.Mesh(
        new THREE.RingGeometry(0.97, 1, 48),
        new THREE.MeshBasicMaterial({ color: 0xffdd55, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
    );
    terrainBrushRing.rotation.x = -Math.PI / 2;
    terrainBrushRing.visible = false;
    scene.add(terrainBrushRing);

    ruler = new RulerTool({
        scene,
        tooltip: document.getElementById('ruler-tooltip'),
        measure: (points) => isHexLayer() ? measurePath(points) : null
    });

    // Show the correct grid (hex vs square) for the current layer
    showLayerGrid(mapDepth(currentMapKey));
    updateBreadcrumb();

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKeyDown);
    renderer.domElement.addEventListener('dblclick', onDoubleClick); // double-click a hex to descend

    // --- Menu Button Listeners (Right) ---
    menuButtons.token = document.getElementById('btn-token');
    menuButtons.cube = document.getElementById('btn-cube');
    menuButtons.sphere = document.getElementById('btn-sphere');
    menuButtons.cave = document.getElementById('btn-cave');
    menuButtons.arch = document.getElementById('btn-arch');
    menuButtons.token.addEventListener('click', () => setSelectedObjectType('token'));
    menuButtons.cube.addEventListener('click', () => setSelectedObjectType('cube'));
    menuButtons.sphere.addEventListener('click', () => setSelectedObjectType('sphere'));
    menuButtons.cave.addEventListener('click', () => setSelectedObjectType('cave'));
    menuButtons.arch.addEventListener('click', () => setSelectedObjectType('arch'));
    // Characters are loaded from the server via Socket.IO (see initSocket).

    // --- Tool Menu Listeners (Left) ---
    toolMenuButtons.move = document.getElementById('btn-tool-move');
    toolMenuButtons.ruler = document.getElementById('btn-tool-ruler');
    toolMenuButtons.tool3 = document.getElementById('btn-tool-3');
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

    toolMenuButtons.tool3.addEventListener('click', () => setTool('tool3'));

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
    radiusInput.addEventListener('input', e => { terrainBrush.radius = +e.target.value; document.getElementById('brush-radius-val').textContent = (+e.target.value).toFixed(0); });
    strengthInput.addEventListener('input', e => { terrainBrush.strength = +e.target.value; document.getElementById('brush-strength-val').textContent = (+e.target.value).toFixed(2); });
    const waterToggle = document.getElementById('water-toggle');
    const waterLevel = document.getElementById('water-level');
    waterToggle.addEventListener('change', e => { terrain.setWater({ enabled: e.target.checked }); emitTerrain({ water: true }); });
    waterLevel.addEventListener('input', e => { terrain.setWater({ level: +e.target.value }); document.getElementById('water-level-val').textContent = (+e.target.value).toFixed(1); });
    waterLevel.addEventListener('change', () => emitTerrain({ water: true }));
    document.getElementById('terrain-reset').addEventListener('click', () => {
        if (!confirm('Reset all terrain on this tactical map?')) return;
        terrain.reset();
        waterToggle.checked = false; waterLevel.value = 0; document.getElementById('water-level-val').textContent = '0.0';
        emitTerrain({ heights: true, splat: true, water: true });
    });

    const upBtn = document.getElementById('btn-up');
    if (upBtn) upBtn.addEventListener('click', goUp);

    dismissSubmenusOnOutsideClick([
        [moveSubMenu, toolMenuButtons.move],
        [rulerSubMenu, toolMenuButtons.ruler]
    ]);

    startRenderLoop({ renderer, scene, camera, controls });
    initSocket();
}

function onPointerDown(event) {
    if (isDraggingHeight) {
        isDraggingHeight = false;
        controls.enabled = true;
        deselectObject();
        return;
    }

    // Terrain sculpt/paint: start a stroke (left button only).
    if (terrainActive() && event.button === 0) {
        const p = pointerToGround(event);
        if (p) {
            isSculpting = true;
            controls.enabled = false;
            strokeRef = terrain.sampleHeight(p.x, p.z);
            strokeChanged = { heights: false, splat: false };
            terrainDab(p);
            updateBrushRing(p);
        }
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
            controls.enabled = false;
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

    // Terrain tool: paint along the drag, or just move the brush ring while hovering.
    if (terrainActive()) {
        const p = pointerToGround(event);
        if (p) {
            if (isSculpting) terrainDab(p);
            updateBrushRing(p);
        }
        if (isSculpting) return;
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

function onPointerUp() {
    // End a terrain stroke and sync only the layer(s) that changed.
    if (isSculpting) {
        isSculpting = false;
        controls.enabled = !terrainActive(); // stays disabled while the terrain tool is active
        if (strokeChanged.heights) terrain.refreshWater(); // pools settle into the new shape
        if (strokeChanged.heights || strokeChanged.splat) emitTerrain(strokeChanged);
        strokeChanged = { heights: false, splat: false };
    }
}

function onContextMenu(event) {
    event.preventDefault();
    if (currentTool !== 'ruler') return;
    castFromPointer(event, { renderer, camera, raycaster, mouse });
    const intersects = raycaster.intersectObject(plane);
    if (intersects.length > 0) {
        ruler.restartAt(getCurrentRulerSnap(intersects[0].point), emitRuler);
    }
}

function onKeyDown(event) {
    if ((event.key === "Delete" || event.key === "Backspace") && selectedObject) {
        const docId = selectedObject.userData.syncId;
        if (docId) {
            socket.emit('delete-object', { id: docId });
            deselectObject();
        }
    }
    if (event.key === "Escape") {
        if (currentTool === 'ruler' && ruler.points.length > 0) {
            ruler.clearInProgress();
        } else if (isDraggingHeight) {
            isDraggingHeight = false;
            controls.enabled = true;
            deselectObject();
        } else if (selectedObject) {
            deselectObject();
        }
    }
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
function terrainActive() { return currentTool === 'terrain' && mapDepth(currentMapKey) === 2; }
function updateTerrainPanel() {
    const panel = document.getElementById('terrain-panel');
    const show = currentTool === 'terrain' && mapDepth(currentMapKey) === 2;
    panel.classList.toggle('hidden', !show);
    if (terrainBrushRing) terrainBrushRing.visible = false;
    // Disable orbit while the terrain tool is active so drags sculpt instead of
    // rotating the camera. Switch to another tool (e.g. Move) to orbit again.
    if (controls) controls.enabled = !terrainActive();
    if (currentTool === 'terrain' && mapDepth(currentMapKey) !== 2) {
        console.warn('Terrain editing is only available on a tactical map (double-click down to one).');
    }
}
function setBrushMode(mode) {
    terrainBrush.mode = mode;
    document.querySelectorAll('#terrain-panel .brush-mode').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
}
function setBrushMaterial(i) {
    terrainBrush.material = i;
    document.querySelectorAll('#terrain-mats .mat-swatch').forEach(b => b.classList.toggle('active', +b.dataset.mat === i));
    if (terrainBrush.mode !== 'paint') setBrushMode('paint');
}
function emitTerrain(flags) {
    if (socket) socket.emit('update-terrain', terrain.delta(flags));
}
function pointerToGround(event) {
    castFromPointer(event, { renderer, camera, raycaster, mouse });
    const hit = raycaster.intersectObject(plane)[0];
    return hit ? hit.point : null;
}
function terrainDab(p) {
    const b = terrainBrush;
    if (b.mode === 'paint') { terrain.paint(p.x, p.z, b.radius, b.strength, b.material); strokeChanged.splat = true; }
    else { terrain.sculpt(p.x, p.z, b.radius, b.strength, b.mode, strokeRef); strokeChanged.heights = true; }
}
function updateBrushRing(p) {
    if (!terrainBrushRing) return;
    terrainBrushRing.visible = true;
    terrainBrushRing.position.set(p.x, terrain.sampleHeight(p.x, p.z) + 0.05, p.z);
    terrainBrushRing.scale.set(terrainBrush.radius, terrainBrush.radius, terrainBrush.radius);
}
// Ground height a token should rest at, for the current map.
function groundY(x, z, halfHeight) {
    const base = (terrain && mapDepth(currentMapKey) === 2) ? terrain.sampleHeight(x, z) : 0;
    return base + halfHeight;
}
function syncWaterControls() {
    if (!terrain) return;
    const t = document.getElementById('water-toggle');
    const l = document.getElementById('water-level');
    const v = document.getElementById('water-level-val');
    if (t) t.checked = terrain.water.enabled;
    if (l) l.value = terrain.water.level;
    if (v) v.textContent = (+terrain.water.level).toFixed(1);
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
