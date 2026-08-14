const SQRT3 = Math.sqrt(3);
const EPSILON = 1e-9;

const finitePoint = (point) => point &&
  Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.z));

function pointInsidePointyHex(point, flatWidth) {
  if (!finitePoint(point) || !Number.isFinite(flatWidth) || flatWidth <= 0) return false;
  const x = Number(point.x), z = Number(point.z);
  const inradius = flatWidth / 2;
  return Math.max(
    Math.abs(x),
    Math.abs(x * 0.5 + z * SQRT3 / 2),
    Math.abs(x * -0.5 + z * SQRT3 / 2)
  ) <= inradius + EPSILON;
}

// Clip a segment against the six half-planes of a pointy-top hex. `padding`
// expands the edge planes for river width, conservatively treating a channel
// brushing the regional boundary as intersecting it.
function segmentIntersectsPointyHex(a, b, flatWidth, padding = 0) {
  if (!finitePoint(a) || !finitePoint(b) || !Number.isFinite(flatWidth) || flatWidth <= 0) return false;
  const ax = Number(a.x), az = Number(a.z);
  const dx = Number(b.x) - ax, dz = Number(b.z) - az;
  const radius = flatWidth / 2 + Math.max(0, Number(padding) || 0);
  const normals = [
    [1, 0], [-1, 0],
    [0.5, SQRT3 / 2], [-0.5, -SQRT3 / 2],
    [-0.5, SQRT3 / 2], [0.5, -SQRT3 / 2]
  ];
  let enter = 0, leave = 1;
  for (const [nx, nz] of normals) {
    const start = nx * ax + nz * az - radius;
    const delta = nx * dx + nz * dz;
    if (Math.abs(delta) <= EPSILON) {
      if (start > EPSILON) return false;
      continue;
    }
    const boundary = -start / delta;
    if (delta > 0) leave = Math.min(leave, boundary);
    else enter = Math.max(enter, boundary);
    if (enter - leave > EPSILON) return false;
  }
  return leave >= -EPSILON && enter <= 1 + EPSILON;
}

function pointSegmentDistance(point, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq <= EPSILON ? 0 : Math.max(0, Math.min(1,
    ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSq));
  return Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t));
}

function pointyHexVertices(flatWidth) {
  const circumradius = flatWidth / SQRT3;
  const halfWidth = flatWidth / 2;
  const halfRadius = circumradius / 2;
  return [
    { x: 0, z: circumradius },
    { x: halfWidth, z: halfRadius },
    { x: halfWidth, z: -halfRadius },
    { x: 0, z: -circumradius },
    { x: -halfWidth, z: -halfRadius },
    { x: -halfWidth, z: halfRadius }
  ];
}

function axisAlignedBoxIntersectsPointyHex(bounds, flatWidth) {
  if (!bounds || !Number.isFinite(flatWidth) || flatWidth <= 0) return false;
  const minX = Number(bounds.minX), maxX = Number(bounds.maxX);
  const minZ = Number(bounds.minZ), maxZ = Number(bounds.maxZ);
  if (![minX, maxX, minZ, maxZ].every(Number.isFinite) || minX > maxX || minZ > maxZ) {
    return false;
  }
  const corners = [
    { x: minX, z: minZ }, { x: maxX, z: minZ },
    { x: maxX, z: maxZ }, { x: minX, z: maxZ }
  ];
  if (corners.some(point => pointInsidePointyHex(point, flatWidth))) return true;
  if (pointyHexVertices(flatWidth).some(point =>
    point.x >= minX - EPSILON && point.x <= maxX + EPSILON &&
    point.z >= minZ - EPSILON && point.z <= maxZ + EPSILON)) return true;
  for (let i = 0; i < corners.length; i++) {
    if (segmentIntersectsPointyHex(corners[i], corners[(i + 1) % corners.length], flatWidth)) {
      return true;
    }
  }
  return false;
}

function circleIntersectsPointyHex(center, radius, flatWidth) {
  if (!finitePoint(center) || !Number.isFinite(flatWidth) || flatWidth <= 0) return false;
  const point = { x: Number(center.x), z: Number(center.z) };
  const r = Math.max(0, Number(radius) || 0);
  if (pointInsidePointyHex(point, flatWidth)) return true;
  const vertices = pointyHexVertices(flatWidth);
  for (let i = 0; i < vertices.length; i++) {
    if (pointSegmentDistance(point, vertices[i], vertices[(i + 1) % vertices.length]) <= r + EPSILON) {
      return true;
    }
  }
  return false;
}

function distance(a, b) {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

function extrapolate(a, b) {
  return { x: 2 * a.x - b.x, z: 2 * a.z - b.z };
}

// Match THREE.CatmullRomCurve3's open, centripetal curve polynomial without a
// browser/Three.js dependency. Sampling is deliberately sub-unit so a narrow
// rendered ribbon that bows across a regional edge cannot hide between coarse
// waypoint chords.
function centripetalSegmentPoint(p0, p1, p2, p3, t) {
  let dt0 = Math.pow((p0.x - p1.x) ** 2 + (p0.z - p1.z) ** 2, 0.25);
  let dt1 = Math.pow((p1.x - p2.x) ** 2 + (p1.z - p2.z) ** 2, 0.25);
  let dt2 = Math.pow((p2.x - p3.x) ** 2 + (p2.z - p3.z) ** 2, 0.25);
  if (dt1 < 1e-4) dt1 = 1;
  if (dt0 < 1e-4) dt0 = dt1;
  if (dt2 < 1e-4) dt2 = dt1;
  const component = (x0, x1, x2, x3) => {
    let tangent1 = (x1 - x0) / dt0 - (x2 - x0) / (dt0 + dt1) + (x2 - x1) / dt1;
    let tangent2 = (x2 - x1) / dt1 - (x3 - x1) / (dt1 + dt2) + (x3 - x2) / dt2;
    tangent1 *= dt1;
    tangent2 *= dt1;
    const c0 = x1;
    const c1 = tangent1;
    const c2 = -3 * x1 + 3 * x2 - 2 * tangent1 - tangent2;
    const c3 = 2 * x1 - 2 * x2 + tangent1 + tangent2;
    return c0 + c1 * t + c2 * t * t + c3 * t * t * t;
  };
  return {
    x: component(p0.x, p1.x, p2.x, p3.x),
    z: component(p0.z, p1.z, p2.z, p3.z)
  };
}

function sampleCentripetalCatmullRom(points, maxSegmentLength = 0.5, maxSamples = 32768) {
  if (!Array.isArray(points) || points.length < 2 || !points.every(finitePoint)) return [];
  const source = points.map(point => ({ x: Number(point.x), z: Number(point.z) }));
  const segments = [];
  let desiredTotal = 0;
  const step = Math.max(0.125, Number(maxSegmentLength) || 0.5);
  for (let i = 0; i < source.length - 1; i++) {
    const p1 = source[i], p2 = source[i + 1];
    const p0 = i > 0 ? source[i - 1] : extrapolate(p1, p2);
    const p3 = i + 2 < source.length ? source[i + 2] : extrapolate(p2, p1);
    let previous = p1;
    let estimatedLength = 0;
    for (let j = 1; j <= 8; j++) {
      const current = centripetalSegmentPoint(p0, p1, p2, p3, j / 8);
      estimatedLength += distance(previous, current);
      previous = current;
    }
    const desired = Math.max(8, Math.ceil(estimatedLength / step));
    segments.push({ p0, p1, p2, p3, desired });
    desiredTotal += desired;
  }
  const budget = Math.max(source.length, Math.floor(Number(maxSamples) || 32768) - 1);
  const scale = desiredTotal > budget ? budget / desiredTotal : 1;
  const sampled = [source[0]];
  for (const segment of segments) {
    const divisions = Math.max(2, Math.floor(segment.desired * scale));
    for (let j = 1; j <= divisions; j++) {
      sampled.push(centripetalSegmentPoint(
        segment.p0, segment.p1, segment.p2, segment.p3, j / divisions
      ));
    }
  }
  return sampled;
}

module.exports = {
  pointInsidePointyHex,
  segmentIntersectsPointyHex,
  circleIntersectsPointyHex,
  axisAlignedBoxIntersectsPointyHex,
  sampleCentripetalCatmullRom
};
