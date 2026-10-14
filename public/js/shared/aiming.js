// aiming.js — the template a spell or breath is aimed with, on both tabletop
// screens. `createAimTool` draws the area (shared/aoe.js) following the
// cursor, draped on the ground, with the range ring round the caster and a
// ring under every creature it would catch; a click commits. The page feeds
// it world-space points and owns the emit — this module only shows.
//
// Everything is added to `worldGroup` (true world coordinates, floating
// origin safe) and ignores raycasts.

import * as THREE from 'three';
import { caughtIn, describeShape, outline, resolveAim } from './aoe.js';
import { BREATH_COLORS } from './monster-anim.js';
import { aimShapeOf, createRangeRing } from './combat.js';
import { buildOccluders, sightBlocked } from './vision.js';

const LIFT = 0.07;          // above the ground it lies on
const RINGS = 5;            // radial steps of the draped fan

// A convex outline → a fan of triangles from `hub`, each vertex seated on the
// ground. Returns { positions, edge } flat arrays.
function drape(points, hub, heightAt) {
    const positions = [];
    const edge = [];
    const at = (x, z) => [x, heightAt(x, z) + LIFT, z];
    const count = points.length;
    for (let i = 0; i < count; i++) {
        const a = points[i], b = points[(i + 1) % count];
        for (let ring = 0; ring < RINGS; ring++) {
            const t0 = ring / RINGS, t1 = (ring + 1) / RINGS;
            const a0 = at(hub[0] + (a[0] - hub[0]) * t0, hub[1] + (a[1] - hub[1]) * t0);
            const b0 = at(hub[0] + (b[0] - hub[0]) * t0, hub[1] + (b[1] - hub[1]) * t0);
            const a1 = at(hub[0] + (a[0] - hub[0]) * t1, hub[1] + (a[1] - hub[1]) * t1);
            const b1 = at(hub[0] + (b[0] - hub[0]) * t1, hub[1] + (b[1] - hub[1]) * t1);
            if (ring === 0) positions.push(...a0, ...b1, ...a1);
            else positions.push(...a0, ...b0, ...b1, ...a0, ...b1, ...a1);
        }
        edge.push(...at(a[0], a[1]), ...at(b[0], b[1]));
    }
    return { positions, edge };
}

// options: worldGroup, getCreatures() → [{ id, x, y, z }], heightAt(x, z, baseY),
// blocked(source, creature) (optional: walls give cover), faint (someone
// else's template, or one waiting for the GM: drawn weak, no range ring).
export function createAimTool({ worldGroup, getCreatures, heightAt, blocked = null, faint = false }) {
    const strength = faint ? 0.45 : 1;
    let pending = null;     // { shape, casterId, name, type, onCommit, point }
    let last = null;        // { aim, caught }
    const fill = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false, side: THREE.DoubleSide
    }));
    const rim = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.95 * strength, depthTest: false
    }));
    fill.renderOrder = 996; rim.renderOrder = 997;
    fill.raycast = () => {}; rim.raycast = () => {};
    fill.frustumCulled = false; rim.frustumCulled = false;
    const group = new THREE.Group();
    group.add(fill, rim);
    group.visible = false;
    let reachRing = null;
    const marks = [];       // rings under caught creatures (pooled)
    const markGeometry = new THREE.RingGeometry(0.42, 0.56, 32);
    markGeometry.rotateX(-Math.PI / 2);
    const markMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 * strength, depthTest: false, side: THREE.DoubleSide });

    function casterOf() {
        return pending && (getCreatures() || []).find(creature => creature.id === pending.casterId);
    }

    function clearReach() {
        if (!reachRing) return;
        group.remove(reachRing);
        reachRing.geometry.dispose(); reachRing.material.dispose();
        reachRing = null;
    }

    function redraw() {
        const caster = casterOf();
        if (!pending || !caster) { group.visible = false; last = null; return; }
        const aim = resolveAim(pending.shape, caster, pending.point || caster);
        const creatures = getCreatures() || [];
        const fromCaster = aim.kind === 'cone' || aim.kind === 'line' || aim.kind === 'self';
        const caught = caughtIn(aim, creatures, { exclude: fromCaster ? caster.id : null, blocked });
        last = { aim, caught };

        const ground = (x, z) => heightAt(x, z, caster.y);
        const points = outline(aim);
        const hub = aim.kind === 'cone' || aim.kind === 'line'
            ? [aim.origin.x + aim.dir.x * aim.size * 0.5, aim.origin.z + aim.dir.z * aim.size * 0.5]
            : [aim.center.x, aim.center.z];
        const { positions, edge } = drape(points, hub, ground);
        fill.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        rim.geometry.setAttribute('position', new THREE.Float32BufferAttribute(edge, 3));
        fill.geometry.computeBoundingSphere(); rim.geometry.computeBoundingSphere();

        if (reachRing) reachRing.position.set(caster.x, ground(caster.x, caster.z) + LIFT, caster.z);
        const byId = new Map(creatures.map(creature => [creature.id, creature]));
        caught.forEach((id, index) => {
            let mark = marks[index];
            if (!mark) {
                mark = new THREE.Mesh(markGeometry, markMaterial);
                mark.renderOrder = 998; mark.raycast = () => {};
                marks.push(mark); group.add(mark);
            }
            const creature = byId.get(id);
            mark.position.set(creature.x, ground(creature.x, creature.z) + LIFT + 0.01, creature.z);
            mark.visible = true;
        });
        for (let i = caught.length; i < marks.length; i++) marks[i].visible = false;
        group.visible = true;
    }

    return {
        get active() { return !!pending; },
        get name() { return pending ? pending.name : ''; },

        // spec: { shape, casterId, name, type (damage type → colour), onCommit(point, caughtIds) }
        begin(spec) {
            this.cancel();
            pending = { ...spec, point: null };
            const color = new THREE.Color(BREATH_COLORS[spec.type] || '#f5e6c2');
            fill.material.color.copy(color);
            rim.material.color.copy(color).lerp(new THREE.Color('#ffffff'), 0.35);
            markMaterial.color.copy(color).lerp(new THREE.Color('#ffffff'), 0.5);
            const aim = resolveAim(spec.shape, { x: 0, z: 0 }, { x: 0, z: 0 });
            if (!faint && aim.reach > 0 && aim.kind !== 'cone' && aim.kind !== 'line' && aim.kind !== 'self') {
                reachRing = createRangeRing(aim.reach);
                reachRing.raycast = () => {};
                group.add(reachRing);
            }
            if (!group.parent) worldGroup.add(group);
            redraw();
        },

        // The cursor moved: `point` is a true-world ground position.
        move(point) {
            if (!pending || !point) return;
            pending.point = { x: point.x, z: point.z };
            redraw();
        },

        // Tokens moved or the map changed under an open template.
        refresh() { if (pending) redraw(); },

        // → true when something was committed.
        commit() {
            if (!pending) return false;
            const caster = casterOf();
            if (!caster) { this.cancel(); return false; }
            redraw();
            const { onCommit } = pending;
            // The server clamps to range itself; send where the area really sits.
            const point = last.aim.kind === 'cone' || last.aim.kind === 'line'
                ? { x: caster.x + last.aim.dir.x, z: caster.z + last.aim.dir.z }
                : { x: last.aim.center.x, z: last.aim.center.z };
            const caught = last.caught.slice();
            this.cancel();
            if (onCommit) onCommit(point, caught);
            return true;
        },

        cancel() {
            if (!pending) return false;
            pending = null; last = null;
            clearReach();
            group.visible = false;
            for (const mark of marks) mark.visible = false;
            return true;
        },

        hint() {
            if (!pending) return '';
            const count = last ? last.caught.length : 0;
            const what = describeShape(pending.shape);
            const self = pending.shape.kind === 'self';
            return `${pending.name}${what ? ` (${what})` : ''}: ${count} caught — ${self ? 'click to release' : 'move to aim, click to release'} · Esc cancels`;
        },

        // A slow pulse so the template reads as "not yet real".
        tick(seconds) {
            if (!pending || !group.visible) return;
            fill.material.opacity = (0.18 + 0.07 * Math.sin(seconds * 4)) * strength;
        },

        // For good: a ghost whose player stopped aiming.
        dispose() {
            this.cancel();
            if (group.parent) group.parent.remove(group);
            fill.geometry.dispose(); fill.material.dispose();
            rim.geometry.dispose(); rim.material.dispose();
            markGeometry.dispose(); markMaterial.dispose();
        }
    };
}

// Areas that linger in a fight (`combat.zones`), on both tabletop screens: each
// one stays drawn on the ground in its damage colour — weaker than a template
// being aimed, stronger than a ghost — and a zone that follows its caster is
// redrawn as the caster moves. Pages call `sync(combat && combat.zones)` when
// the combat state arrives and `tick()` per frame.
export function createZoneLayer({ worldGroup, objects, terrain }) {
    const probe = createSceneProbe({ objects, terrain });
    const drawn = new Map(); // zone id → { group, fill, rim, zone, stamp }
    const started = performance.now();
    let checkedAt = 0;

    function aimOf(zone) {
        if (!zone.follow) return zone.aim;
        const caster = probe.getCreatures().find(creature => creature.id === zone.sourceId);
        return caster ? { ...zone.aim, origin: { x: caster.x, z: caster.z }, center: { x: caster.x, z: caster.z } } : zone.aim;
    }
    function draw(entry) {
        const aim = aimOf(entry.zone);
        const stamp = JSON.stringify([aim.origin, aim.center, aim.dir, aim.size, aim.width]);
        if (stamp === entry.stamp) return;
        entry.stamp = stamp;
        const caster = probe.getCreatures().find(creature => creature.id === entry.zone.sourceId);
        const baseY = caster ? caster.y : 0.1;
        const hub = aim.kind === 'cone' || aim.kind === 'line'
            ? [aim.origin.x + aim.dir.x * aim.size * 0.5, aim.origin.z + aim.dir.z * aim.size * 0.5]
            : [aim.center.x, aim.center.z];
        const { positions, edge } = drape(outline(aim), hub, (x, z) => probe.heightAt(x, z, baseY));
        entry.fill.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        entry.rim.geometry.setAttribute('position', new THREE.Float32BufferAttribute(edge, 3));
        entry.fill.geometry.computeBoundingSphere(); entry.rim.geometry.computeBoundingSphere();
    }
    function remove(id) {
        const entry = drawn.get(id);
        if (!entry) return;
        if (entry.group.parent) entry.group.parent.remove(entry.group);
        for (const mesh of [entry.fill, entry.rim]) { mesh.geometry.dispose(); mesh.material.dispose(); }
        drawn.delete(id);
    }

    return {
        sync(zones) {
            const list = (Array.isArray(zones) ? zones : []).filter(zone => zone && zone.aim && typeof zone.id === 'string');
            const wanted = new Set(list.map(zone => zone.id));
            for (const id of [...drawn.keys()]) if (!wanted.has(id)) remove(id);
            probe.reset();
            for (const zone of list) {
                let entry = drawn.get(zone.id);
                if (!entry) {
                    const color = new THREE.Color(BREATH_COLORS[zone.damageType] || '#f5e6c2');
                    const fill = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
                        color, transparent: true, opacity: 0.16, depthTest: false, depthWrite: false, side: THREE.DoubleSide
                    }));
                    const rim = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
                        color: color.clone().lerp(new THREE.Color('#ffffff'), 0.25), transparent: true, opacity: 0.7, depthTest: false
                    }));
                    fill.renderOrder = 994; rim.renderOrder = 995;
                    fill.raycast = () => {}; rim.raycast = () => {};
                    fill.frustumCulled = false; rim.frustumCulled = false;
                    const group = new THREE.Group();
                    group.add(fill, rim);
                    worldGroup.add(group);
                    entry = { group, fill, rim, zone, stamp: '' };
                    drawn.set(zone.id, entry);
                }
                entry.zone = zone;
                draw(entry);
            }
        },
        tick() {
            if (!drawn.size) return;
            const now = performance.now();
            const seconds = (now - started) / 1000;
            const follow = now - checkedAt > 150;
            if (follow) { checkedAt = now; probe.reset(); }
            let index = 0;
            for (const entry of drawn.values()) {
                entry.fill.material.opacity = 0.13 + 0.05 * Math.sin(seconds * 1.6 + index++);
                if (follow && entry.zone.follow) draw(entry);
            }
        }
    };
}

// What a template needs to know about the page's map: which creatures are on
// it, where the ground is, what the walls hide. `objects()` is the page's list
// of synced meshes, `terrain()` its terrain (or null). → the three callbacks
// createAimTool takes, plus reset() (the caster may have changed level).
export function createSceneProbe({ objects, terrain }) {
    const isCreature = (object) => !!object.userData.characterData || object.userData.objectType === 'token';
    const getCreatures = () => objects().filter(object => object.visible !== false && isCreature(object) && object.userData.syncId)
        .map(object => ({ id: object.userData.syncId, x: object.position.x, y: object.position.y, z: object.position.z }));
    const ground = (x, z) => {
        const land = terrain();
        return land && land.group.visible ? land.sampleHeight(x, z) : 0;
    };
    // A caster on a floor or a bridge aims a flat template at that level; on
    // the land it follows the slope.
    let level = null;
    const heightAt = (x, z, baseY) => {
        if (level && level.baseY !== baseY) level = null;
        if (!level) {
            const caster = getCreatures().find(creature => creature.y === baseY);
            const soles = baseY - 0.1;
            level = { baseY, flat: caster && Math.abs(soles - ground(caster.x, caster.z)) > 0.4 ? soles : null };
        }
        return level.flat != null ? level.flat : ground(x, z);
    };
    // Walls and shut doors give total cover (the server rules the same way on
    // the same records). Rebuilt at most twice a second.
    let occluders = null, occludersAt = 0;
    const blocked = (source, creature) => {
        const now = performance.now();
        if (!occluders || now - occludersAt > 500) {
            occludersAt = now;
            occluders = buildOccluders(objects().map(object => ({
                ...(object.userData.objectData || {}),
                type: object.userData.characterData ? 'character' : object.userData.objectType,
                position: { x: object.position.x, y: object.position.y, z: object.position.z }
            })));
        }
        return sightBlocked(occluders, source.x, creature.y + 0.5, source.z, creature.x, creature.y + 0.5, creature.z);
    };
    return { getCreatures, heightAt, blocked, reset() { level = null; } };
}

// The combat glue both tabletop pages share: the scene probe and the
// `combat-action` a click sends. `flash`/`onChange` are the page's tracker
// line and hint bar.
export function createCombatAim({ worldGroup, objects, terrain, getSocket, flash = () => {}, onChange = () => {} }) {
    const probe = createSceneProbe({ objects, terrain });
    const tool = createAimTool({ worldGroup, ...probe });
    const started = performance.now();

    return {
        get active() { return tool.active; },
        // Takes the aim when the spell or ability covers an area (→ true);
        // otherwise the page's click-a-token pick handles it (→ false).
        begin(combatantId, index, item, mode, extra = {}) {
            const shape = aimShapeOf(item, mode);
            if (!shape) return false;
            probe.reset();
            tool.begin({
                shape, casterId: combatantId, name: item.name, type: item.damageType,
                onCommit: (point) => {
                    const socket = getSocket();
                    if (!socket) return;
                    socket.emit('combat-action', mode === 'cast'
                        ? { combatantId, kind: 'cast', spellIndex: index, aim: point, ...extra }
                        : { combatantId, kind: 'ability', abilityIndex: index, aim: point, ...extra });
                }
            });
            flash(tool.hint());
            onChange();
            return true;
        },
        move(point) { if (tool.active) { tool.move(point); onChange(); } },
        refresh() { probe.reset(); tool.refresh(); },
        commit() { const done = tool.commit(); if (done) onChange(); return done; },
        cancel(silent = false) {
            const name = tool.name;
            if (!tool.cancel()) return false;
            if (!silent) flash(`${name} cancelled`);
            onChange();
            return true;
        },
        hint() { return tool.hint(); },
        tick() { tool.tick((performance.now() - started) / 1000); }
    };
}
