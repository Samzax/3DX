// hexworld.js — the world-scale hex lattice shared by the GM screen and the
// terrain generator. Hex tiers are zoom lenses over the one continuous world:
// a hex at depth d is TIER_WIDTH[d] world units flat-to-flat (DMG p14 scales,
// 1 world unit = 1 tactical cell = 5 ft), and each layer's hex field is
// centered on its parent hex's center. The math here MUST match server.js
// (hexCenterAtTier / provinceWorldCenter) — the server is the source of truth
// for how map keys map to world positions.

const SQRT3 = Math.sqrt(3);

// Hex pitch (flat-to-flat, world units) per tier depth 0,1,2:
// Continent 60 mi, Kingdom 6 mi, Province 1 mi (1 mi = 1056 cells of 5 ft).
export const TIER_WIDTH = [63360, 6336, 1056];
export const HEX_FIELD_RADIUS = 6;   // hex field radius per layer, in hexes
export const TACTICAL_DEPTH = 3;     // depth of the square-grid leaf

// Pointy-top circumradius for a tier (flat-to-flat width = sqrt(3) * R).
export function tierRadius(depth) { return TIER_WIDTH[depth] / SQRT3; }

// Pointy-top axial hex center (world units) for hex (q,r) at a tier.
export function hexCenterAtTier(depth, q, r) {
    const R = tierRadius(depth);
    return { x: R * SQRT3 * (q + r / 2), z: R * 1.5 * r };
}

// Cube-round fractional axial coords to the containing hex.
export function roundHex(qf, rf) {
    let rx = Math.round(qf), ry = Math.round(-qf - rf), rz = Math.round(rf);
    const dx = Math.abs(rx - qf), dy = Math.abs(ry - (-qf - rf)), dz = Math.abs(rz - rf);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy <= dz) rz = -rx - ry;
    return { q: rx, r: rz };
}

// Containing hex (q,r) at a tier for a LOCAL point (relative to the tier
// lattice's center — the parent hex center, or the world origin at depth 0).
export function worldToHexAtTier(depth, x, z) {
    const R = tierRadius(depth);
    return roundHex((SQRT3 / 3 * x - 1 / 3 * z) / R, (2 / 3 * z) / R);
}

export function hexDistance(a, b = { q: 0, r: 0 }) {
    return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}
export function hexInField(q, r) {
    return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= HEX_FIELD_RADIUS;
}

// World center of any world-tree map key ("world", "world/q,r", ...) — the
// client twin of server.js provinceWorldCenter.
export function pathWorldCenter(key) {
    const segs = key.split('/');
    let x = 0, z = 0;
    for (let d = 1; d < segs.length && d <= 3; d++) {
        const [q, r] = segs[d].split(',').map(Number);
        const c = hexCenterAtTier(d - 1, q, r);
        x += c.x; z += c.z;
    }
    return { x, z };
}

// Distance (world units) from a LOCAL point to the boundary of its containing
// hex (q,r) at a tier: inradius minus the largest projection onto the three
// pointy-top edge normals. >= 0 inside the hex; used to feather biome
// overrides so painted terrain blends into its neighbors instead of cliffing.
export function hexEdgeDistance(depth, x, z, q, r) {
    const c = hexCenterAtTier(depth, q, r);
    const px = x - c.x, pz = z - c.z;
    const inradius = TIER_WIDTH[depth] / 2;
    const p1 = Math.abs(px);                                  // normal (1, 0)
    const p2 = Math.abs(px * 0.5 + pz * SQRT3 / 2);           // normal (1/2, √3/2)
    const p3 = Math.abs(px * -0.5 + pz * SQRT3 / 2);          // normal (-1/2, √3/2)
    return inradius - Math.max(p1, p2, p3);
}
