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
// Stylized-look pass (step 1): a soft warm sky the distant world dissolves into.
// SKY_COLOR is shared by scene.background AND the fog so far terrain fades into
// the sky (atmospheric perspective) with no hard patch edge. Only near/far are
// animated per-frame in terrain.js; this color stays put.
export const SKY_COLOR = 0xbcd6ea;

// A vertical gradient sky as a screen-filling background texture: soft deep blue
// at the zenith easing down to SKY_COLOR at the horizon, so distant fogged terrain
// (fog is also SKY_COLOR) melts seamlessly into the base of the sky. A stretched
// CanvasTexture needs no sky dome and no per-frame upkeep, and stays robust across
// the whole Continent->Tactical zoom range. The horizon stop MUST stay SKY_COLOR
// so the fog fade has no seam.
function makeSkyGradientTexture() {
    const c = document.createElement('canvas');
    c.width = 2; c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0.00, '#5b8ac4'); // zenith: soft deep blue
    g.addColorStop(0.55, '#9cc0e2'); // mid sky
    g.addColorStop(1.00, '#bcd6ea'); // horizon = SKY_COLOR (matches the fog)
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 2, 512);
    return new THREE.CanvasTexture(c);
}

// Build the standard tabletop scene. The ground plane is named "tabletop" — pointer
// handlers rely on that name to tell ground clicks from object clicks.
export function createTabletopScene(container) {
    const scene = new THREE.Scene();
    scene.background = makeSkyGradientTexture();
    // Fog color MUST match the sky's horizon stop so distant ground/grid fade
    // seamlessly into it instead of showing a hard patch edge.
    scene.fog = new THREE.Fog(SKY_COLOR, FOG_NEAR, FOG_FAR);

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

    // Stylized fill: a hemisphere light (warm sky from above, warm earth bounce
    // from below) instead of flat white ambient. This is what turns flat Lambert
    // shading into soft, wrap-around, sunny relief — shaded slopes pick up a warm
    // ground tint rather than going dead grey. Position-independent, so it stays
    // correct anywhere on the roaming world. Keep total illumination ~1.0:
    // over-lighting saturates colors toward white/yellow.
    scene.add(new THREE.HemisphereLight(0xcfe3f2, 0x8f7f5f, 0.55));
    const dirLight = new THREE.DirectionalLight(0xffe8c4, 0.9);
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

// ===== GM-directed camera flights =====
// Eased camera fly-to that runs in TRUE world coordinates and converts through
// the current floating origin every tick, so a mid-flight rebase can't bend the
// path. One instance per page; call tick() from onTick (it runs before
// controls.update(), so a live flight owns camera.position + controls.target
// for that frame). pose = { pos:{x,y,z}, look:{x,y,z} } in world coords.
export class CameraFly {
    constructor(camera, controls) {
        this.camera = camera;
        this.controls = controls;
        this.flight = null;
    }
    get active() { return !!this.flight; }
    // origin: the CURRENT world origin ({x,z}) — needed to lift the camera's
    // scene-space pose into world space for the start point. duration seconds;
    // defaults to a distance-scaled 0.6–2.5s.
    start(pose, origin, duration) {
        const from = {
            pos: {
                x: this.camera.position.x + origin.x,
                y: this.camera.position.y,
                z: this.camera.position.z + origin.z
            },
            look: {
                x: this.controls.target.x + origin.x,
                y: this.controls.target.y,
                z: this.controls.target.z + origin.z
            }
        };
        const dist = Math.hypot(pose.look.x - from.look.x, pose.look.z - from.look.z);
        this.flight = {
            from, to: pose,
            t0: performance.now(),
            dur: 1000 * (duration || Math.min(2.5, 0.6 + dist / 1500))
        };
    }
    cancel() { this.flight = null; }
    tick(origin) {
        const f = this.flight;
        if (!f) return false;
        const t = Math.min(1, (performance.now() - f.t0) / f.dur);
        const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2; // easeInOutQuad
        const L = (a, b) => a + (b - a) * e;
        this.camera.position.set(
            L(f.from.pos.x, f.to.pos.x) - origin.x,
            L(f.from.pos.y, f.to.pos.y),
            L(f.from.pos.z, f.to.pos.z) - origin.z);
        this.controls.target.set(
            L(f.from.look.x, f.to.look.x) - origin.x,
            L(f.from.look.y, f.to.look.y),
            L(f.from.look.z, f.to.look.z) - origin.z);
        if (t >= 1) this.flight = null;
        return true;
    }
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

// Snap to the square tactical grid (keeps y). Objects land on the CENTER of the
// cell they're dropped in (floor + 0.5), the way a mini sits in the middle of a
// square — not on the grid-line corner that Math.round would round to.
export function snapToGrid(position) {
    return new THREE.Vector3(
        (Math.floor(position.x / GRID_CELL_SIZE) + 0.5) * GRID_CELL_SIZE,
        position.y,
        (Math.floor(position.z / GRID_CELL_SIZE) + 0.5) * GRID_CELL_SIZE
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
