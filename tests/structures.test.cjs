const assert = require('node:assert/strict');
const path = require('node:path');
const { before, test } = require('node:test');
const { loadStructuresModule } = require('./helpers/load-browser-module.cjs');

const repoRoot = path.resolve(__dirname, '..');
const plain = (value) => JSON.parse(JSON.stringify(value));
let structures;

before(async () => {
  structures = await loadStructuresModule(repoRoot);
});

test('structure levels normalize and stairs touch both connected storeys', () => {
  assert.equal(structures.structureLevel(null), 0);
  assert.equal(structures.structureLevel({ level: '2.6' }), 3);
  assert.equal(structures.structureLevel({ level: 'not-a-level' }), 0);

  assert.equal(structures.structureTouchesLevel({ type: 'floor', level: -1 }, -1), true);
  assert.equal(structures.structureTouchesLevel({ type: 'floor', level: -1 }, 0), false);
  assert.equal(structures.structureTouchesLevel({ type: 'stair', level: -1, toLevel: 0 }, -1), true);
  assert.equal(structures.structureTouchesLevel({ type: 'stair', level: -1, toLevel: 0 }, 0), true);
  assert.equal(structures.structureTouchesLevel({ type: 'stair', level: 2, rise: -2 }, 1), true);
  assert.equal(structures.structureTouchesLevel({ type: 'stair', level: 2, rise: -2 }, 0), false);
  assert.equal(structures.structureTouchesLevel(null, 0), false);

  assert.equal(structures.structureStoreyLevel({ type: 'roof', level: 3, coversLevel: 2 }), 2);
  assert.equal(structures.structureBelongsToStorey({ type: 'roof', level: 3, coversLevel: 2 }, 2), true);
  assert.equal(structures.structureBelongsToStorey({ type: 'stair', level: -1, toLevel: 0 }, -1), true);

  const stair = { type: 'stair', level: 0, toLevel: 1, rise: 2, levelHeight: 2 };
  assert.equal(structures.structureStairRiseCompatible(stair, 2), true);
  assert.equal(structures.structureStairRiseCompatible({ ...stair, toLevel: 5 }, 2), false);
  assert.equal(structures.structureStairRiseCompatible({ ...stair, toLevel: -1 }, 2), false);
  assert.equal(structures.structureStairRiseCompatible({ ...stair, toLevel: -1, rise: -2 }, 2), true);
  assert.equal(structures.structureRoofLevelCompatible({ type: 'roof', level: 1, coversLevel: 0 }), true);
  assert.equal(structures.structureRoofLevelCompatible({ type: 'roof', level: 10, coversLevel: 0 }), false);
  assert.equal(structures.structureHeightModeCompatible({ type: 'floor', level: 0, heightMode: 'terrain' }), true);
  assert.equal(structures.structureHeightModeCompatible({ type: 'floor', level: 1, heightMode: 'terrain' }), false);
  assert.equal(structures.structureHeightModeCompatible({ type: 'roof', level: 0, heightMode: 'terrain' }), false);
});

test('whole-storey copies remap identity and align terrain pieces to the building datum', () => {
  const floor = {
    id: 'map-floor', addedBy: 'GM', type: 'floor', level: 0, levelHeight: 2,
    heightMode: 'terrain', buildingId: 'building-a', structureId: 'structure-old',
    buildingDatumY: 5, position: { x: 10, y: 7, z: -3 }, cols: 2, rows: 2,
    ys: [0.2, -0.1, 0.4, 0], tiles: [null, 'gap', null, null]
  };
  const floorCopy = plain(structures.duplicateStructureToStorey(floor, 2, {
    buildingId: 'building-a', structureId: 'structure-new', buildingDatumY: 5
  }));
  assert.equal(floorCopy.id, undefined);
  assert.equal(floorCopy.addedBy, undefined);
  assert.equal(floorCopy.structureId, 'structure-new');
  assert.equal(floorCopy.level, 2);
  assert.equal(floorCopy.heightMode, 'flat');
  assert.deepEqual(floorCopy.position, { x: 10, y: 9, z: -3 });
  assert.deepEqual(floorCopy.ys, [0, 0, 0, 0]);
  assert.deepEqual(floorCopy.tiles, floor.tiles);
  assert.deepEqual(floor.ys, [0.2, -0.1, 0.4, 0], 'source data must remain unchanged');

  const roofCopy = plain(structures.duplicateStructureToStorey({
    type: 'roof', level: 1, coversLevel: 0, levelHeight: 2,
    buildingId: 'building-a', buildingDatumY: 5,
    position: { x: 1, y: 7, z: 2 }, cols: 2, rows: 1
  }, 1, { buildingId: 'building-a', structureId: 'roof-new', buildingDatumY: 5 }));
  assert.equal(roofCopy.coversLevel, 1);
  assert.equal(roofCopy.level, 2);
  assert.equal(roofCopy.position.y, 9);

  const stairCopy = plain(structures.duplicateStructureToStorey({
    type: 'stair', level: 0, toLevel: 1, rise: 2, levelHeight: 2,
    buildingId: 'building-a', buildingDatumY: 5,
    position: { x: 2, y: 5, z: 2 }, bx: 3, bz: 0
  }, -1, { buildingId: 'building-a', structureId: 'stair-new', buildingDatumY: 5 }));
  assert.equal(stairCopy.level, -1);
  assert.equal(stairCopy.toLevel, 0);
  assert.equal(stairCopy.position.y, 3);
});

test('building datums distinguish explicit grouping from compatible legacy terrain', () => {
  const nullDatumPiece = {
    type: 'floor', level: 2, levelHeight: 2, buildingDatumY: null,
    buildingId: 'building-null-datum', position: { x: 1, y: 9, z: 2 }, cols: 1, rows: 1
  };
  assert.equal(structures.structureBuildingDatum(nullDatumPiece), 5,
    'a null datum must be derived rather than coerced to zero');
  const nullDatumCopy = plain(structures.duplicateStructureToStorey(nullDatumPiece, 3, {
    structureId: 'structure-null-datum-copy'
  }));
  assert.equal(nullDatumCopy.buildingDatumY, 5);
  assert.equal(nullDatumCopy.position.y, 11);
  assert.equal(structures.structureDatumCompatible(nullDatumPiece, null), false);
  assert.equal(structures.structureDatumCompatible({
    type: 'floor', level: 0, levelHeight: 2, heightMode: 'terrain',
    position: { y: 12 }
  }, 5), true, 'legacy ground terrain may follow a different anchor height');
  assert.equal(structures.structureDatumCompatible({
    type: 'floor', level: 1, levelHeight: 2, heightMode: 'flat',
    position: { y: 9 }
  }, 5), false, 'a fixed legacy upper storey must already align to the datum');
  assert.equal(structures.structureDatumCompatible({
    type: 'wall', level: 0, levelHeight: 2, heightMode: 'terrain',
    buildingDatumY: 8, position: { y: 12 }
  }, 5), false, 'an explicitly grouped piece cannot silently change datum');
  assert.equal(structures.structureDatumCompatible({
    type: 'roof', level: 1, levelHeight: 2, heightMode: 'flat',
    buildingDatumY: 5, position: { y: 15 }
  }, 5), false, 'an explicit datum cannot hide a vertically detached flat piece');
});

test('structure type and tile-count guards stay bounded', () => {
  for (const type of ['wall', 'floor', 'stair', 'roof']) {
    assert.equal(structures.isStructureType(type), true, type);
  }
  assert.equal(structures.isStructureType('portal'), false);

  assert.equal(structures.structureTileCount({ type: 'wall', cols: 3, rows: 2 }), 0);
  assert.equal(structures.structureTileCount({ type: 'floor', cols: 3.9, rows: 2 }), 6);
  assert.equal(structures.structureTileCount({ type: 'roof', cols: 0, rows: -4 }), 1);
  assert.equal(structures.structureTileCount({ type: 'floor', cols: 999, rows: 999 }), 48 * 48);
});

test('wall gestures snap, retain their first axis, and respect the total-cell cap', () => {
  assert.deepEqual(plain(structures.wallGesturePath(
    { x: 0.49, z: 0.51 },
    { x: 3.4, z: 4.4 }
  )), {
    axis: 'x',
    points: [{ x: 0, z: 1 }, { x: 3, z: 1 }, { x: 3, z: 4 }]
  });

  assert.deepEqual(plain(structures.wallGesturePath(
    { x: 0, z: 0 },
    { x: 5, z: 2 },
    'z',
    4
  )), {
    axis: 'z',
    points: [{ x: 0, z: 0 }, { x: 0, z: 2 }, { x: 2, z: 2 }]
  });

  const capped = structures.wallGesturePath({ x: 0, z: 0 }, { x: 80, z: 80 }, 'x', 48);
  assert.equal(structures.wallSegmentCount({ path: plain(capped.points) }), 48);
});

test('saved and legacy wall paths normalize diagonals into deterministic orthogonal legs', () => {
  const diagonal = { path: [{ x: 0, z: 0 }, { x: 2.2, z: 2.7 }] };
  assert.deepEqual(plain(structures.wallPathPoints(diagonal)), [
    { x: 0, z: 0 },
    { x: 2, z: 0 },
    { x: 2, z: 3 }
  ]);
  assert.equal(structures.wallSegmentCount(diagonal), 5);

  assert.deepEqual(plain(structures.wallPathPoints({ bx: -3.2, bz: 2.8 })), [
    { x: 0, z: 0 },
    { x: -3, z: 0 },
    { x: -3, z: 3 }
  ]);
  assert.equal(structures.wallSegmentCount({ bx: -3.2, bz: 2.8 }), 6);

  const oversized = { path: [{ x: 0, z: 0 }, { x: 30, z: 30 }] };
  assert.deepEqual(plain(structures.wallPathPoints(oversized)), [
    { x: 0, z: 0 },
    { x: 30, z: 0 },
    { x: 30, z: 18 }
  ]);
  assert.equal(structures.wallSegmentCount(oversized), 48);
});

test('scruffy variation is stable for the same seed and piece', () => {
  const value = structures.buildRand(123, 4, 2);
  assert.equal(value, 0.9684161690529436);
  assert.equal(structures.buildRand(123, 4, 2), value);
  assert.notEqual(structures.buildRand(123, 4, 3), value);
  assert.ok(value >= 0 && value < 1);
});
