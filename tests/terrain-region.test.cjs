const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  pointInsidePointyHex,
  segmentIntersectsPointyHex,
  axisAlignedBoxIntersectsPointyHex,
  sampleCentripetalCatmullRom
} = require('../lib/terrain-region.cjs');

const PROVINCE_WIDTH = 1056;

test('pointy province geometry detects crossing river segments without inside waypoints', () => {
  assert.equal(pointInsidePointyHex({ x: -600, z: 0 }, PROVINCE_WIDTH), false);
  assert.equal(pointInsidePointyHex({ x: 600, z: 0 }, PROVINCE_WIDTH), false);
  assert.equal(segmentIntersectsPointyHex(
    { x: -600, z: 0 }, { x: 600, z: 0 }, PROVINCE_WIDTH
  ), true);
  assert.equal(segmentIntersectsPointyHex(
    { x: 600, z: -100 }, { x: 600, z: 100 }, PROVINCE_WIDTH
  ), false);
  assert.equal(segmentIntersectsPointyHex(
    { x: 529, z: -100 }, { x: 529, z: 100 }, PROVINCE_WIDTH
  ), false);
  assert.equal(segmentIntersectsPointyHex(
    { x: 529, z: -100 }, { x: 529, z: 100 }, PROVINCE_WIDTH, 2
  ), true);
});

test('lake Chebyshev footprint boxes overlap province edges and corners', () => {
  assert.equal(axisAlignedBoxIntersectsPointyHex(
    { minX: 520.5, maxX: 559.5, minZ: -19.5, maxZ: 19.5 }, PROVINCE_WIDTH
  ), true);
  assert.equal(axisAlignedBoxIntersectsPointyHex(
    { minX: 540.5, maxX: 559.5, minZ: -9.5, maxZ: 9.5 }, PROVINCE_WIDTH
  ), false);
  // A maxRadius=20 lake at this seed can occupy square cells near the pointy
  // hex corner even though a Euclidean radius-20 circle would miss it.
  assert.equal(axisAlignedBoxIntersectsPointyHex(
    { minX: 520, maxX: 559, minZ: 309, maxZ: 348 }, PROVINCE_WIDTH
  ), true);
});

test('centripetal river sampling catches a rendered bow missed by waypoint chords', () => {
  const points = [
    { x: 537.50, z: 341.83 }, { x: 486.05, z: 461.91 },
    { x: 549.51, z: 249.21 }, { x: 717.45, z: 382.05 }
  ];
  assert.equal(points.slice(1).some((point, index) =>
    segmentIntersectsPointyHex(points[index], point, PROVINCE_WIDTH)), false);
  const curve = sampleCentripetalCatmullRom(points);
  assert.equal(curve.slice(1).some((point, index) =>
    segmentIntersectsPointyHex(curve[index], point, PROVINCE_WIDTH, 1.25)), true);
});
