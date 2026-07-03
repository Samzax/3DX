// scene.js — three.js tabletop boilerplate shared by the GM (/gm) and player (/player) screens:
// scene, camera, renderer, orbit controls, lights, ground plane and square grid.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const GRID_SIZE = 1000;
export const GRID_DIVISIONS = 1000;
export const GRID_CELL_SIZE = GRID_SIZE / GRID_DIVISIONS;
export const FEET_PER_GRID_CELL = 5;

// Build the standard tabletop scene. The ground plane is named "tabletop" — pointer
// handlers rely on that name to tell ground clicks from object clicks.
export function createTabletopScene(container) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x2d2d2d);

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 10000);
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
    controls.target.set(0, 0, 0);

    scene.add(new THREE.AmbientLight(0xaaaaaa, 1.5));
    const dirLight = new THREE.DirectionalLight(0xffffff, 3);
    dirLight.position.set(10, 20, 5);
    dirLight.castShadow = true;
    dirLight.shadow.camera.top = 500;
    dirLight.shadow.camera.bottom = -500;
    dirLight.shadow.camera.left = -500;
    dirLight.shadow.camera.right = 500;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    scene.add(dirLight);

    const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(GRID_SIZE, GRID_SIZE),
        new THREE.MeshStandardMaterial({ color: 0x4a4a4a, side: THREE.DoubleSide })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.receiveShadow = true;
    plane.name = "tabletop";
    scene.add(plane);

    const grid = new THREE.GridHelper(GRID_SIZE, GRID_DIVISIONS, 0x888888, 0x888888);
    grid.material.opacity = 0.5;
    grid.material.transparent = true;
    grid.position.y = 0.01;
    scene.add(grid);

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return { scene, camera, renderer, controls, plane, grid, raycaster, mouse };
}

export function startRenderLoop({ renderer, scene, camera, controls }) {
    (function animate() {
        requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
    })();
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
