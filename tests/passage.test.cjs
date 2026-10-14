const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..');
const load = () => import(pathToFileURL(path.join(repoRoot, 'public', 'js', 'shared', 'passage.js')).href);

// A cell 4 wide and 3 deep (x 0..4, z 0..3): masonry on three sides, a front
// of iron bars along z = 3 with a door in the wall cell x 2..3.
function jail(door) {
  const wall = (id, x, z, bx, bz, extra = {}) => ({
    id, type: 'wall', position: { x, y: 0, z }, bx, bz, wallHeight: 3, ...extra
  });
  const bars = (x) => ({ id: 'bars' + x, type: 'prop', kind: 'bars', rot: 0, position: { x: x + 0.5, y: 0, z: 3 } });
  return [
    wall('back', 0, 0, 4, 0), wall('left', 0, 0, 0, 3), wall('right', 4, 0, 0, 3),
    bars(0), bars(1), bars(3),
    wall('door', 2, 3, 1, 0, { segments: ['door'], ...(door ? { doors: [door] } : {}) })
  ];
}
const at = (x, z, feet = 0) => ({ x, z, feet });

test('a shut or locked cell holds its prisoner; an open door lets them out', async () => {
  const { buildBarriers, walkable } = await load();
  const inside = at(0.5, 1.5), corridor = at(0.5, 4.5), beyondTheWall = at(-1.5, 1.5);
  for (const state of [null, 'locked']) {
    const shut = buildBarriers(jail(state));
    assert.equal(walkable(shut, inside, at(3.5, 0.5)).ok, true, 'free to walk inside the cell');
    assert.equal(walkable(shut, inside, corridor).ok, false, 'bars stop a straight walk');
    assert.equal(walkable(shut, inside, at(2.5, 3.5)).ok, false, 'the shut door stops one too');
    assert.equal(walkable(shut, inside, beyondTheWall).ok, false);
  }
  const open = buildBarriers(jail('open'));
  assert.deepEqual(walkable(open, at(2.5, 2.5), at(2.5, 3.5)), { ok: true, detour: false, cells: 1 });
  const round = walkable(open, inside, corridor);
  assert.equal(round.ok, true, 'out through the door and back along the bars');
  assert.equal(round.detour, true);
  assert.ok(round.cells > 3, 'the walk round is longer than the straight line');
  // The far side of the side wall is reachable now, but only the long way.
  const behind = walkable(open, inside, beyondTheWall);
  assert.equal(behind.detour, true, 'an open door does not open the walls');
  assert.ok(behind.cells > round.cells);
});

test('windows stop a walker, gaps do not, and a diagonal cannot cut a corner', async () => {
  const { buildBarriers, walkable } = await load();
  const run = { id: 'w', type: 'wall', position: { x: 0, y: 0, z: 0 }, bx: 3, bz: 0, wallHeight: 2, segments: ['window', 'gap', null] };
  const barriers = buildBarriers([run]);
  // A free-standing run can always be walked round: what matters is whether
  // the straight step goes through it.
  assert.equal(walkable(barriers, at(0.5, -0.5), at(0.5, 0.5)).detour, true, 'window');
  assert.equal(walkable(barriers, at(1.5, -0.5), at(1.5, 0.5)).detour, false, 'gap');
  // (2.5,-0.5) → (3.5,0.5) slips past the end of the wall only by cutting its corner.
  const corner = walkable(barriers, at(2.5, -0.5), at(3.5, 0.5));
  assert.equal(corner.ok, true);
  assert.equal(corner.detour, true, 'round the end of the wall, not through its corner');
});

test('a wall on another storey does not stop a walker', async () => {
  const { buildBarriers, walkable } = await load();
  const upstairs = { id: 'u', type: 'wall', position: { x: 0, y: 4, z: 0 }, bx: 3, bz: 0, wallHeight: 2 };
  const barriers = buildBarriers([upstairs]);
  assert.equal(walkable(barriers, at(1.5, -0.5), at(1.5, 0.5)).detour, false);
  assert.equal(walkable(barriers, at(1.5, -0.5, 4), at(1.5, 0.5, 4)).detour, true);
});

test('furniture poses name props the server knows', async () => {
  const { PROP_POSES, POSE_KINDS, BARRIER_PROPS } = await load();
  const server = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
  const kinds = new Function(`return ${server.match(/const PROP_KINDS = (\[.*?\]);/)[1]};`)();
  for (const kind of [...Object.keys(PROP_POSES), ...BARRIER_PROPS]) assert.ok(kinds.includes(kind), kind);
  for (const pose of Object.values(PROP_POSES)) assert.ok(POSE_KINDS.includes(pose), pose);
});
