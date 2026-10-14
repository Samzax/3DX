// touch.js — touch input for the two tabletop screens (gm + player).
//
// The pages' tools are written for a mouse: the left button acts, the pointer
// hovers, the camera lives on the other buttons and the keyboard confirms or
// cancels. A finger has none of that, so `attachTouchInput` takes every touch
// on the map canvas before OrbitControls and the page's own listeners see it
// (capture phase on the canvas's parent) and turns it into:
//
//   tap              → handlers.tap(event)        a click where the finger lifted
//   double tap       → handlers.doubleTap(event)  after the second tap, like dblclick
//   long press       → handlers.hold(event)       the right-click
//   one-finger drag  → the drag handlers.claim(event) returned for that spot
//                      ({ start?, move?, end?, cancel? }), else a camera pan
//   two fingers      → the camera: the ground is held under the fingers (pan,
//                      pinch = zoom, twist = turn); two fingers side by side
//                      dragged up or down tilt instead
//
// Handlers get a plain mouse-shaped object (clientX/Y, movementX/Y, button 0,
// no modifier keys), so a page can pass it straight to its pointer handlers.
// Mouse and pen input is not touched. `createTouchBar` is the row of buttons
// that stands in for Enter / Esc / Delete while a finger is the pointer.

import * as THREE from 'three';

const SLOP = 9;          // px a finger may wander and still be a tap
const HOLD_MS = 550;     // long press
const DOUBLE_MS = 320;   // two taps this close in time...
const DOUBLE_PX = 32;    // ...and in place are a double tap
const DECIDE_PX = 10;    // two-finger travel before the gesture is read as tilt or grab

export function attachTouchInput({ surface, camera, controls, handlers = {} }) {
    const canvas = controls.domElement;
    const fingers = new Map();   // pointerId → { x, y, startX, startY, prevX, prevY, sentX, sentY }
    let gesture = null;          // 'pending' | 'pan' | 'drag' | 'two' | 'spent'
    let drag = null;             // the claimed drag of the first finger
    let two = null;              // two-finger state
    let holdTimer = 0;
    let lastTap = null;
    let lastTouchAt = -1e9;
    let touchMode = false;

    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const offset = new THREE.Vector3();
    const shift = new THREE.Vector3();
    const groundA = new THREE.Vector3();
    const groundB = new THREE.Vector3();
    const spherical = new THREE.Spherical();

    // --- Camera (scene space; controls.update() re-reads the pose each frame) ---

    // The point of the target's ground plane under a screen position, or null
    // at and above the horizon.
    function groundUnder(x, y, out) {
        const rect = canvas.getBoundingClientRect();
        ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
        camera.updateMatrixWorld();
        ray.setFromCamera(ndc, camera);
        const origin = ray.ray.origin, dir = ray.ray.direction;
        if (dir.y > -0.04) return null;
        const t = (controls.target.y - origin.y) / dir.y;
        if (!(t > 0) || t > camera.position.distanceTo(controls.target) * 12) return null;
        return out.copy(dir).multiplyScalar(t).add(origin);
    }

    // Move camera and target so the ground that was under (fromX, fromY) is
    // under (toX, toY). `from` may be a ground point taken before the camera turned.
    function slide(from, fromX, fromY, toX, toY) {
        const to = from && groundUnder(toX, toY, groundB);
        const reach = camera.position.distanceTo(controls.target);
        if (from && to) {
            shift.subVectors(from, to);
        } else {
            // Near the horizon: by screen distance, as far as the target is.
            const perPixel = 2 * reach * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / canvas.clientHeight;
            const right = groundA.setFromMatrixColumn(camera.matrixWorld, 0);
            const ahead = groundB.subVectors(controls.target, camera.position);
            right.y = 0; ahead.y = 0;
            if (ahead.lengthSq() < 1e-8) ahead.setFromMatrixColumn(camera.matrixWorld, 1).setY(0);
            right.normalize(); ahead.normalize();
            shift.copy(right).multiplyScalar(-(toX - fromX) * perPixel)
                .addScaledVector(ahead, (toY - fromY) * perPixel);
        }
        shift.y = 0;
        if (shift.length() > reach * 1.5) shift.setLength(reach * 1.5);
        camera.position.add(shift);
        controls.target.add(shift);
    }

    function orbit(azimuth, polar) {
        offset.subVectors(camera.position, controls.target);
        spherical.setFromVector3(offset);
        spherical.theta += azimuth;
        spherical.phi = THREE.MathUtils.clamp(spherical.phi + polar,
            Math.max(controls.minPolarAngle, 0.02), controls.maxPolarAngle);
        offset.setFromSpherical(spherical);
        camera.position.copy(controls.target).add(offset);
        camera.lookAt(controls.target);
    }

    function zoom(factor) {
        offset.subVectors(camera.position, controls.target);
        offset.setLength(THREE.MathUtils.clamp(offset.length() * factor, controls.minDistance, controls.maxDistance));
        camera.position.copy(controls.target).add(offset);
    }

    // --- Gestures ---

    function shaped(finger) {
        const event = {
            clientX: finger.x, clientY: finger.y, pageX: finger.x, pageY: finger.y,
            movementX: finger.x - finger.sentX, movementY: finger.y - finger.sentY,
            button: 0, buttons: 1, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false,
            pointerType: 'touch', target: canvas,
            preventDefault() {}, stopPropagation() {}
        };
        finger.sentX = finger.x; finger.sentY = finger.y;
        return event;
    }

    function setMode(touch) {
        if (touch === touchMode) return;
        touchMode = touch;
        document.body.classList.toggle('touch-input', touch);
        if (handlers.mode) handlers.mode(touch);
    }

    function cameraTaken() { if (handlers.camera) handlers.camera(); }

    function pair() {
        const [a, b] = [...fingers.values()];
        return {
            midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2,
            sepX: b.x - a.x, sepY: b.y - a.y,
            spread: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
            angle: Math.atan2(b.y - a.y, b.x - a.x)
        };
    }
    const turnBetween = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

    function twoFingerMove() {
        const now = pair();
        if (!two.mode) {
            const midX = now.midX - two.start.midX, midY = now.midY - two.start.midY;
            const spread = now.spread - two.start.spread;
            const twist = turnBetween(two.start.angle, now.angle) * now.spread / 2; // px at a finger
            if (Math.max(Math.abs(midX), Math.abs(midY), Math.abs(spread), Math.abs(twist)) < DECIDE_PX) return;
            const tilt = Math.abs(midY) > 2 * Math.abs(midX) && Math.abs(midY) > 1.5 * Math.abs(spread) &&
                Math.abs(twist) < 0.75 * Math.abs(midY) && Math.abs(now.sepX) > Math.abs(now.sepY);
            two.mode = tilt ? 'tilt' : 'grab';
            two.prev = now;
            cameraTaken();
            return;
        }
        if (two.mode === 'tilt') {
            orbit(0, -(now.midY - two.prev.midY) * Math.PI / canvas.clientHeight);
        } else {
            const held = groundUnder(two.prev.midX, two.prev.midY, groundA);
            orbit(turnBetween(two.prev.angle, now.angle), 0);
            zoom(two.prev.spread / now.spread);
            slide(held, two.prev.midX, two.prev.midY, now.midX, now.midY);
        }
        two.prev = now;
    }

    function onDown(e) {
        if (e.pointerType !== 'touch' || e.target !== canvas) return;
        e.stopPropagation();
        lastTouchAt = performance.now();
        if (fingers.size >= 2) return; // a third finger is ignored
        const finger = {
            x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY,
            prevX: e.clientX, prevY: e.clientY, sentX: e.clientX, sentY: e.clientY
        };
        fingers.set(e.pointerId, finger);
        clearTimeout(holdTimer);
        if (fingers.size === 1) {
            gesture = 'pending';
            drag = handlers.claim ? handlers.claim(shaped(finger)) : null;
            holdTimer = setTimeout(() => {
                if (gesture !== 'pending') return;
                gesture = 'spent';
                if (handlers.hold) handlers.hold(shaped(finger));
            }, HOLD_MS);
            return;
        }
        // A second finger: whatever the first was doing, this is the camera now.
        if (gesture === 'drag' && drag && drag.cancel) drag.cancel();
        drag = null;
        if (controls.enabled) { gesture = 'two'; two = { mode: null, start: pair(), prev: null }; }
        else gesture = 'spent';
    }

    function onMove(e) {
        if (e.pointerType !== 'touch' || e.target !== canvas) return;
        e.stopPropagation();
        const finger = fingers.get(e.pointerId);
        if (!finger) return;
        lastTouchAt = performance.now();
        finger.x = e.clientX; finger.y = e.clientY;

        if (gesture === 'pending') {
            if (Math.hypot(finger.x - finger.startX, finger.y - finger.startY) < SLOP) return;
            clearTimeout(holdTimer);
            if (drag) {
                gesture = 'drag';
                if (drag.start) {
                    // The drag begins where the finger went down, not where it is now.
                    const at = { x: finger.x, y: finger.y };
                    finger.x = finger.startX; finger.y = finger.startY;
                    drag.start(shaped(finger));
                    finger.x = at.x; finger.y = at.y;
                }
            } else if (controls.enabled) {
                gesture = 'pan';
                cameraTaken();
            } else {
                gesture = 'spent';
            }
        }
        if (gesture === 'drag') {
            if (drag.move) drag.move(shaped(finger));
        } else if (gesture === 'pan') {
            slide(groundUnder(finger.prevX, finger.prevY, groundA), finger.prevX, finger.prevY, finger.x, finger.y);
        } else if (gesture === 'two' && fingers.size === 2) {
            twoFingerMove();
        }
        finger.prevX = finger.x; finger.prevY = finger.y;
    }

    function onUp(e) {
        if (e.pointerType !== 'touch' || e.target !== canvas) return;
        e.stopPropagation();
        const finger = fingers.get(e.pointerId);
        if (!finger) return;
        const cancelled = e.type === 'pointercancel';
        lastTouchAt = performance.now();
        finger.x = e.clientX; finger.y = e.clientY;
        fingers.delete(e.pointerId);
        clearTimeout(holdTimer);

        if (gesture === 'pending' && !cancelled) {
            const event = shaped(finger);
            const again = lastTap && lastTouchAt - lastTap.at < DOUBLE_MS &&
                Math.hypot(finger.x - lastTap.x, finger.y - lastTap.y) < DOUBLE_PX;
            lastTap = again ? null : { at: lastTouchAt, x: finger.x, y: finger.y };
            if (handlers.tap) handlers.tap(event);
            if (again && handlers.doubleTap) handlers.doubleTap(event);
        } else if (gesture === 'drag' && drag) {
            if (cancelled) { if (drag.cancel) drag.cancel(); }
            else if (drag.end) drag.end(shaped(finger));
        } else if (gesture === 'two' && fingers.size === 1) {
            // One finger left the pair: the other carries on as a pan.
            const rest = [...fingers.values()][0];
            rest.prevX = rest.x; rest.prevY = rest.y;
            gesture = controls.enabled ? 'pan' : 'spent';
            two = null;
            return;
        }
        if (fingers.size === 0) { gesture = null; drag = null; two = null; }
    }

    // The browser's own double-click and long-press menu would run the page's
    // mouse handlers a second time for a gesture already handled above.
    function swallowAfterTouch(e) {
        if (performance.now() - lastTouchAt > 900) return;
        e.preventDefault();
        e.stopPropagation();
    }

    surface.addEventListener('pointerdown', onDown, true);
    surface.addEventListener('pointermove', onMove, true);
    surface.addEventListener('pointerup', onUp, true);
    surface.addEventListener('pointercancel', onUp, true);
    surface.addEventListener('dblclick', swallowAfterTouch, true);
    surface.addEventListener('contextmenu', swallowAfterTouch, true);
    // Which pointer the screen is being worked with: hints and the action bar follow it.
    window.addEventListener('pointerdown', (e) => setMode(e.pointerType === 'touch'), true);

    return {
        get touch() { return touchMode; }
    };
}

// The buttons a touch screen needs where a keyboard has Enter, Esc and Delete.
// set([{ label, run, kind?: 'primary'|'danger' }]) — an empty list hides the
// bar; `after` runs once a button has done its work (the page's hint refresh).
export function createTouchBar({ after = () => {} } = {}) {
    const bar = document.createElement('div');
    bar.id = 'touch-bar';
    bar.className = 'hidden';
    document.body.appendChild(bar);
    let actions = [];
    let stamp = '';
    bar.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        const action = button && actions[Number(button.dataset.index)];
        if (!action) return;
        action.run();
        after();
    });
    return {
        set(list) {
            actions = list || [];
            // Rebuilt only when the buttons change: a hint refresh must not
            // pull a button from under the finger pressing it.
            const next = actions.map(action => `${action.kind || ''}:${action.label}`).join('|');
            if (next === stamp) return;
            stamp = next;
            bar.textContent = '';
            actions.forEach((action, index) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.dataset.index = index;
                button.textContent = action.label;
                if (action.kind) button.classList.add(action.kind);
                bar.appendChild(button);
            });
            bar.classList.toggle('hidden', !actions.length);
        }
    };
}

// A hint written for mouse and keys, reworded for fingers: key-only parts are
// dropped (the action bar has those), clicks become taps. `oneFingerTool`: the
// tool in hand takes one-finger drags, so the camera needs two.
const KEY_PART = /^(Esc|Enter|Del|Shift|Alt\+|Ctrl\+|Page Up|\[ \]|1-0|\. focus|[A-Z] |RMB|MMB|wheel)/;
export function touchHint(text, oneFingerTool = false) {
    const parts = String(text || '').split(' · ').filter(part => !KEY_PART.test(part.trim())).map(part => part
        .replace(/move to aim, click to release/, 'tap or drag to aim, then Cast')
        .replace(/click to release/, 'press Cast')
        .replace(/\(Enter = yourself\)/, '(Fire = yourself)')
        .replace(/right-click/i, 'hold to')
        .replace(/double-click/g, 'double-tap')
        .replace(/LMB click/g, 'tap')
        .replace(/LMB drag/g, 'drag')
        .replace(/LMB (paint|sculpt)/g, 'drag to $1')
        .replace(/LMB (place|pour|select)/g, 'tap to $1')
        .replace(/LMB/g, 'tap')
        .replace(/click/g, 'tap')
        .replace(/Click/g, 'Tap'));
    parts.push(oneFingerTool ? 'two fingers pan, turn, pinch and tilt' : 'drag pan · two fingers turn, pinch and tilt');
    return parts.join(' · ');
}
