// aoe.js — where a spell, a breath or a burst lands (pure: no three.js/DOM;
// `server.js` imports this same file, so the template a screen previews is the
// area the server rules on). Everything is in true world units on the ground
// plane (x, z); heights are not modelled — a fireball catches what stands
// under it. Feet come in from the rules data and are converted here.

export const FEET_PER_UNIT = 5;          // mirrors scene.js FEET_PER_GRID_CELL / GRID_CELL_SIZE
export const AREA_KINDS = ['single', 'self', 'sphere', 'cylinder', 'cube', 'cone', 'line'];
export const LINE_WIDTH_FT = 5;
// A creature is caught when its centre is inside the area, give or take this
// much (tokens sit on cell centres; a template edge through a cell centre
// should not depend on float noise).
export const CATCH_PAD = 0.05;
const CONE_HALF_TAN = 0.5;               // 5e: a cone is as wide as it is long

const num = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

export const feetToUnits = (feet) => feet / FEET_PER_UNIT;

// { kind, sizeFt, rangeFt, widthFt } with every field in bounds. `rangeFt` 0
// means the area starts at the caster (a breath, Thunderwave, an aura).
export function normalizeShape(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const kind = AREA_KINDS.includes(source.kind) ? source.kind : 'single';
    return {
        kind,
        sizeFt: Math.round(num(source.sizeFt, 0, 300, 0)),
        rangeFt: Math.round(num(source.rangeFt, 0, 600, 0)),
        widthFt: Math.round(num(source.widthFt, 5, 60, LINE_WIDTH_FT))
    };
}

// Does aiming this shape mean picking a point on the ground (true) or a
// creature / nothing at all (false)?
export function shapeNeedsPoint(shape) {
    return !!shape && shape.sizeFt > 0 && shape.kind !== 'single' && shape.kind !== 'self';
}

// Turn "the caster stands here, the cursor is there" into the area itself.
// → { kind, origin, dir, center, size, width, reach, clamped } (world units).
// Cones and lines always leave the caster; a cube with no range is pushed out
// in front of the caster; everything else is centred on the point, pulled
// back inside the range when the cursor is beyond it.
export function resolveAim(rawShape, caster, point) {
    const shape = normalizeShape(rawShape);
    const origin = { x: num(caster && caster.x, -1e9, 1e9, 0), z: num(caster && caster.z, -1e9, 1e9, 0) };
    const target = { x: num(point && point.x, -1e9, 1e9, origin.x), z: num(point && point.z, -1e9, 1e9, origin.z) };
    let dx = target.x - origin.x, dz = target.z - origin.z;
    const distance = Math.hypot(dx, dz);
    const dir = distance > 1e-6 ? { x: dx / distance, z: dz / distance } : { x: 0, z: 1 };
    const size = feetToUnits(shape.sizeFt);
    const reach = feetToUnits(shape.rangeFt);
    const aim = { kind: shape.kind, origin, dir, center: { ...origin }, size, width: feetToUnits(shape.widthFt), reach, clamped: false };
    if (shape.kind === 'self' || shape.kind === 'cone' || shape.kind === 'line') return aim;
    if (shape.kind === 'cube' && reach === 0) {
        aim.center = { x: origin.x + dir.x * size / 2, z: origin.z + dir.z * size / 2 };
        return aim;
    }
    const along = Math.min(distance, reach);
    aim.clamped = distance > reach + 1e-6;
    aim.center = { x: origin.x + dir.x * along, z: origin.z + dir.z * along };
    return aim;
}

// Is the ground point (x, z) inside the area? `pad` grows the area (a big
// creature's body, or CATCH_PAD).
export function inArea(aim, x, z, pad = CATCH_PAD) {
    if (!aim) return false;
    switch (aim.kind) {
        case 'single':
            return false;
        case 'self':
        case 'sphere':
        case 'cylinder':
            return Math.hypot(x - aim.center.x, z - aim.center.z) <= aim.size + pad;
        case 'cube': {
            const rx = x - aim.center.x, rz = z - aim.center.z;
            const along = rx * aim.dir.x + rz * aim.dir.z;
            const across = -rx * aim.dir.z + rz * aim.dir.x;
            const half = aim.size / 2 + pad;
            return Math.abs(along) <= half && Math.abs(across) <= half;
        }
        case 'cone': {
            const rx = x - aim.origin.x, rz = z - aim.origin.z;
            const along = rx * aim.dir.x + rz * aim.dir.z;
            const across = Math.abs(-rx * aim.dir.z + rz * aim.dir.x);
            if (along <= 1e-6 || Math.hypot(rx, rz) > aim.size + pad) return false;
            return across <= along * CONE_HALF_TAN + pad;
        }
        case 'line': {
            const rx = x - aim.origin.x, rz = z - aim.origin.z;
            const along = rx * aim.dir.x + rz * aim.dir.z;
            const across = Math.abs(-rx * aim.dir.z + rz * aim.dir.x);
            return along > 1e-6 && along <= aim.size + pad && across <= aim.width / 2 + pad;
        }
        default:
            return false;
    }
}

// Where the effect comes from, for cover: the caster for cones, lines and
// auras, the centre of a burst otherwise.
export function sourcePoint(aim) {
    return aim.kind === 'cone' || aim.kind === 'line' || aim.kind === 'self' ? aim.origin : aim.center;
}

// The ids of the creatures caught. creatures: [{ id, x, z, radius? }];
// `exclude` leaves the caster out of its own cone, line or aura;
// `blocked(source, creature)` says a wall stands between the two (total cover).
export function caughtIn(aim, creatures, { exclude = null, blocked = null } = {}) {
    const source = sourcePoint(aim);
    const ids = [];
    for (const creature of creatures || []) {
        if (!creature || creature.id == null || creature.id === exclude) continue;
        if (!inArea(aim, creature.x, creature.z, CATCH_PAD + (Number(creature.radius) || 0))) continue;
        if (blocked && blocked(source, creature)) continue;
        ids.push(creature.id);
    }
    return ids;
}

// The template's edge as a closed ring of [x, z] world points (the screens
// draw it; tests read it).
export function outline(aim, segments = 48) {
    const points = [];
    const at = (along, across) => [
        aim.origin.x + aim.dir.x * along - aim.dir.z * across,
        aim.origin.z + aim.dir.z * along + aim.dir.x * across
    ];
    switch (aim.kind) {
        case 'self': case 'sphere': case 'cylinder':
            for (let i = 0; i < segments; i++) {
                const a = (i / segments) * Math.PI * 2;
                points.push([aim.center.x + Math.cos(a) * aim.size, aim.center.z + Math.sin(a) * aim.size]);
            }
            break;
        case 'cube': {
            const half = aim.size / 2;
            for (const [along, across] of [[-half, -half], [half, -half], [half, half], [-half, half]]) {
                points.push([
                    aim.center.x + aim.dir.x * along - aim.dir.z * across,
                    aim.center.z + aim.dir.z * along + aim.dir.x * across
                ]);
            }
            break;
        }
        case 'cone': {
            // Apex, then the far arc from one edge to the other.
            const half = Math.atan(CONE_HALF_TAN);
            const steps = Math.max(4, Math.round(segments / 4));
            points.push(at(0, 0));
            for (let i = 0; i <= steps; i++) {
                const a = -half + (i / steps) * half * 2;
                points.push(at(Math.cos(a) * aim.size, Math.sin(a) * aim.size));
            }
            break;
        }
        case 'line': {
            const half = aim.width / 2;
            points.push(at(0, -half), at(aim.size, -half), at(aim.size, half), at(0, half));
            break;
        }
        default:
            break;
    }
    return points;
}

// "20 ft sphere", "15 ft cone", "100 ft line" — for buttons and hints.
export function describeShape(rawShape) {
    const shape = normalizeShape(rawShape);
    if (shape.kind === 'single') return '';
    if (shape.kind === 'self') return shape.sizeFt ? `${shape.sizeFt} ft aura` : 'self';
    if (!shape.sizeFt) return shape.kind;
    const radius = shape.kind === 'sphere' || shape.kind === 'cylinder';
    return `${shape.sizeFt} ft ${radius ? 'radius' : shape.kind}`;
}
