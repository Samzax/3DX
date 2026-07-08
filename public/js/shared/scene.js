// scene.js — three.js tabletop boilerplate shared by the GM (/gm) and player (/player) screens:
// scene, camera, renderer, orbit controls, lights, ground plane and square grid.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const GRID_SIZE = 2000;            // ground/grid patch extent (cells)
export const GRID_DIVISIONS = 2000;       // 1-cell grid squares (GRID_CELL_SIZE = 1)
export const GRID_CELL_SIZE = GRID_SIZE / GRID_DIVISIONS;
export const FEET_PER_GRID_CELL = 5;
// Zoom bounds + default (zoomed-in) fog distances. maxDistance keeps zoom inside
// the far plane; the page pushes fog out and shows the U3 summary LOD past
// SUMMARY_THRESH so far zoom-out shows the world map instead of void.
const MIN_ZOOM = 3, MAX_ZOOM = 6000;
export const FOG_NEAR = 350, FOG_FAR = 1400;

// Build the standard tabletop scene. The ground plane is named "tabletop" — pointer
// handlers rely on that name to tell ground clicks from object clicks.
export function createTabletopScene(container) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x2d2d2d);
    // Fog color MUST match the background so distant ground/grid fade seamlessly
    // into it instead of showing a hard patch edge.
    scene.fog = new THREE.Fog(0x2d2d2d, FOG_NEAR, FOG_FAR);

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 40000);
    camera.position.set(20, 30, 20);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.maxPolarAngle = Math.PI / 2.1;
    controls.minDistance = MIN_ZOOM;   // can't zoom into the ground
    controls.maxDistance = MAX_ZOOM;   // can't zoom out into the void / get stuck
    controls.target.set(0, 0, 0);
    // Editor-style input split: the left button always belongs to the active tool,
    // the camera lives on the right/middle buttons + wheel, and is never disabled.
    controls.mouseButtons = {
        LEFT: null,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.ROTATE
    };

    // Keep total illumination ~1.0: over-lighting saturates colors toward
    // white/yellow (dark green ground was rendering as cream).
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dirLight = new THREE.DirectionalLight(0xfff2dd, 0.85);
    dirLight.position.set(10, 20, 5);
    dirLight.castShadow = true;
    dirLight.shadow.camera.top = 500;
    dirLight.shadow.camera.bottom = -500;
    dirLight.shadow.camera.left = -500;
    dirLight.shadow.camera.right = 500;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    // Bias against self-shadow acne (contour-band artifacts on rolling terrain:
    // the shadow map texel is ~0.5u over a +-500u camera, so unbiased depth
    // comparisons stripe every slope).
    dirLight.shadow.bias = -0.0008;
    dirLight.shadow.normalBias = 1.5;
    scene.add(dirLight);
    // The light + its shadow camera follow the view (updateWorldFollow), so
    // shadows work anywhere on the unbounded world, not just near the origin.
    dirLight.target.position.set(0, 0, 0);
    scene.add(dirLight.target);

    const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(GRID_SIZE, GRID_SIZE),
        new THREE.MeshStandardMaterial({ color: 0x4a4a4a, side: THREE.DoubleSide })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.receiveShadow = true;
    plane.name = "tabletop";
    scene.add(plane);

    // Kept for API compat but hidden: the grid is now drawn in the terrain
    // shader (Terrain material) so it drapes on the 3D surface instead of being
    // a flat sheet that moirés and slices through hills.
    const grid = new THREE.GridHelper(GRID_SIZE, GRID_DIVISIONS, 0x888888, 0x888888);
    grid.material.opacity = 0.5;
    grid.material.transparent = true;
    grid.position.y = 0.01;
    grid.visible = false;
    scene.add(grid);

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    // World-space container for game content (tokens, props, rulers, previews).
    // Children keep TRUE world coordinates; the group sits at -worldOrigin so
    // rendered transforms stay near zero on the unbounded unified world (the
    // large offsets cancel in float64 on the CPU before the GPU sees them).
    // Terrain manages its own origin subtraction (Terrain.setWorldOrigin).
    const worldGroup = new THREE.Group();
    worldGroup.name = 'world-space';
    scene.add(worldGroup);

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return { scene, camera, renderer, controls, plane, grid, raycaster, mouse, dirLight, worldGroup };
}

// ===== Floating origin (docs/unified-world-design.md §5) =====
// Game logic uses TRUE world coordinates everywhere; only rendering shifts by
// -worldOrigin (terrain internally, everything else via worldGroup). Scene ->
// world is `scene + origin`; pages convert at the raycast boundary.
export const REBASE_DISTANCE = 4096;
// The origin always sits on a 25u multiple: a common multiple of the shader
// grid's close-up cells (1u and 5u), so grid lines don't visibly shift across
// a rebase. (Water-surface noise is scene-space and jumps pattern on a rebase;
// rebases only fire thousands of units out, where that's imperceptible.)
const REBASE_SNAP = 25;

// Hard-set the floating origin (map joins / province flights). Returns the
// snapped origin so callers can place the camera in scene coordinates.
export function setWorldOriginAt({ terrain, worldGroup }, x, z) {
    const ox = Math.round(x / REBASE_SNAP) * REBASE_SNAP;
    const oz = Math.round(z / REBASE_SNAP) * REBASE_SNAP;
    terrain.setWorldOrigin(ox, oz);
    if (worldGroup) worldGroup.position.set(-ox, 0, -oz);
    return { x: ox, z: oz };
}

// Per-frame check: once the camera target drifts REBASE_DISTANCE from the scene
// origin, slide the world origin under it. Camera and target shift together in
// the same frame, so nothing moves on screen (OrbitControls state is relative).
export function maybeRebaseWorld({ terrain, worldGroup, camera, controls }) {
    const t = controls.target;
    if (Math.max(Math.abs(t.x), Math.abs(t.z)) < REBASE_DISTANCE) return false;
    const oldX = terrain.worldOrigin.x, oldZ = terrain.worldOrigin.z;
    const n = setWorldOriginAt({ terrain, worldGroup }, oldX + t.x, oldZ + t.z);
    const dx = n.x - oldX, dz = n.z - oldZ;
    camera.position.x -= dx; camera.position.z -= dz;
    t.x -= dx; t.z -= dz;
    return true;
}

// Recenter the ground plane, grid, and sun light on the camera target each frame
// so they follow the view. The generated terrain (Terrain.updateWindow) is what
// actually fills the world with ground; the plane is just a thin backdrop under
// it. Call each frame from onTick. `grid.userData.wanted === false` keeps the
// grid off for layers that shouldn't show a square grid.
export function updateWorldFollow({ plane, grid, dirLight }, center) {
    const sx = Math.round(center.x), sz = Math.round(center.z);
    if (grid && grid.visible) grid.position.set(sx, grid.position.y, sz);
    // Move the plane even while invisible: it stays the raycast anchor for
    // ground picks when the LOD rings are the visible ground.
    if (plane) plane.position.set(sx, plane.position.y, sz);
    if (dirLight) {
        dirLight.position.set(center.x + 10, 20, center.z + 5);
        dirLight.target.position.set(center.x, 0, center.z);
    }
}

export function startRenderLoop({ renderer, scene, camera, controls, onTick }) {
    (function animate() {
        requestAnimationFrame(animate);
        if (onTick) onTick();
        controls.update();
        renderer.render(scene, camera);
    })();
}

// Style the tabletop plane as the implicit flat ground under sparse terrain chunks:
// sits 0.02 below y=0 so flat (untouched) chunk areas never z-fight it, tinted like
// grass so unedited space reads as ground, not void. `off` restores the neutral look.
export function styleGroundForTerrain(plane, on) {
    if (!plane) return;
    plane.visible = true;
    plane.position.y = on ? -0.02 : 0;
    plane.material.color.set(on ? 0x4a7a3a : 0x4a4a4a);
}

// Boundary rectangle for finite pocket maps (dungeons/rooms), W x H cells centered
// on the origin. Pages add/remove it on map switches.
export function buildBoundsRect(widthCells, heightCells, color = 0xffdd55) {
    const w = widthCells / 2, h = heightCells / 2, y = 0.03;
    const pts = [
        new THREE.Vector3(-w, y, -h), new THREE.Vector3(w, y, -h),
        new THREE.Vector3(w, y, h), new THREE.Vector3(-w, y, h),
        new THREE.Vector3(-w, y, -h)
    ];
    return new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 })
    );
}

// Right-drag orbits the camera, so a contextmenu event only counts as a deliberate
// right-CLICK when the pointer barely moved between down and up. Returns a predicate
// to call from the contextmenu handler: true means "this was a drag, ignore it".
export function trackRightDrag(domElement, threshold = 6) {
    let downX = 0, downY = 0, down = false;
    domElement.addEventListener('pointerdown', (e) => {
        if (e.button === 2) { down = true; downX = e.clientX; downY = e.clientY; }
    });
    return (event) => {
        if (!down) return false;
        down = false;
        return Math.hypot(event.clientX - downX, event.clientY - downY) > threshold;
    };
}

// Point the raycaster at a pointer event's position; returns the raycaster.
export function castFromPointer(event, { renderer, camera, raycaster, mouse }) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    return raycaster;
}

// Snap to the square tactical grid (keeps y).
export function snapToGrid(position) {
    return new THREE.Vector3(
        Math.round(position.x / GRID_CELL_SIZE) * GRID_CELL_SIZE,
        position.y,
        Math.round(position.z / GRID_CELL_SIZE) * GRID_CELL_SIZE
    );
}

// Ruler snapping: cell centers or corners, pinned just above the tabletop.
export function rulerSnap(rawPosition, snapMode) {
    let snappedX, snappedZ;
    if (snapMode === 'center') {
        snappedX = (Math.floor(rawPosition.x / GRID_CELL_SIZE) + 0.5) * GRID_CELL_SIZE;
        snappedZ = (Math.floor(rawPosition.z / GRID_CELL_SIZE) + 0.5) * GRID_CELL_SIZE;
    } else { // 'corner'
        snappedX = Math.round(rawPosition.x / GRID_CELL_SIZE) * GRID_CELL_SIZE;
        snappedZ = Math.round(rawPosition.z / GRID_CELL_SIZE) * GRID_CELL_SIZE;
    }
    return new THREE.Vector3(snappedX, 0.02, snappedZ);
}
