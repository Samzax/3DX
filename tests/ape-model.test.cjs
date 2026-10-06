const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

async function loadApeModel() {
  const threeFilename = path.join(repoRoot, 'public', 'vendor', 'three', 'three.module.js');
  const apeFilename = path.join(repoRoot, 'public', 'js', 'shared', 'ape-model.js');
  const context = vm.createContext({ console });
  const options = { context };

  const three = new vm.SourceTextModule(fs.readFileSync(threeFilename, 'utf8'), {
    ...options,
    identifier: pathToFileURL(threeFilename).href
  });
  const ape = new vm.SourceTextModule(fs.readFileSync(apeFilename, 'utf8'), {
    ...options,
    identifier: pathToFileURL(apeFilename).href
  });

  await three.link(() => {
    throw new Error('The vendored Three.js module should not import dependencies.');
  });
  await ape.link(specifier => {
    if (specifier === 'three') return three;
    throw new Error(`Unexpected ape-model.js import: ${specifier}`);
  });
  await three.evaluate();
  await ape.evaluate();
  return { ape: ape.namespace, three: three.namespace };
}

test('ape variants expose stable IDs and normalize unknown values', async () => {
  const { ape } = await loadApeModel();
  assert.deepEqual(Array.from(ape.APE_VARIANTS, variant => variant.id), [
    'silverback', 'highland', 'albino'
  ]);
  assert.equal(ape.normalizeApeVariant(' HIGHLAND '), 'highland');
  assert.equal(ape.normalizeApeVariant('missing'), 'silverback');
  assert.equal(ape.normalizeApeVariant(null), 'silverback');
  for (const variant of ape.APE_VARIANTS) {
    assert.match(variant.texture, new RegExp(`/ape/${variant.id}-fur\\.webp$`));
  }
});

test('ape model is a detailed, ground-seated, rig-ready hierarchy', async () => {
  const { ape, three } = await loadApeModel();
  const model = ape.createApeModel({ variant: 'silverback', loadTextures: false });
  const names = new Set();
  let meshCount = 0;
  let shadowMeshCount = 0;
  model.traverse(object => {
    names.add(object.name);
    if (object.isMesh) {
      meshCount++;
      if (object.castShadow && object.receiveShadow) shadowMeshCount++;
      assert.equal(object.userData.ownGeometry, true);
    }
  });

  assert.equal(model.name, 'ApeModel');
  assert.equal(model.userData.monsterModel, 'ape');
  assert.equal(model.userData.monsterVariant, 'silverback');
  assert.equal(model.userData.textureStatus, 'disabled');
  assert.ok(meshCount >= 20, `expected a complete anatomical model, got ${meshCount} meshes`);
  assert.ok(meshCount <= 30, `ape must stay within the 30-draw-call budget, got ${meshCount} meshes`);
  assert.equal(shadowMeshCount, meshCount);

  for (const jointName of ape.APE_RIG_JOINTS) {
    assert.ok(names.has(jointName), `missing named rig joint ${jointName}`);
    assert.equal(model.getObjectByName(jointName).userData.isApeRigJoint, true);
  }
  for (const feature of [
    'ApeCranium', 'ApeMuzzle', 'ApeNose', 'ApeMouthLine',
    'ApePalm.L', 'ApePalm.R', 'ApeFoot.L', 'ApeFoot.R', 'ApeBackSaddle'
  ]) {
    assert.ok(names.has(feature), `missing anatomical feature ${feature}`);
  }

  const bounds = new three.Box3().setFromObject(model);
  assert.ok(Math.abs(bounds.min.y + ape.APE_MODEL_GROUND_OFFSET) < 0.025,
    `feet should sit at -${ape.APE_MODEL_GROUND_OFFSET}, got ${bounds.min.y}`);
  assert.ok(bounds.max.y > 1.0 && bounds.max.y < 1.25,
    `Medium ape should be roughly one five-foot world unit tall, got ${bounds.max.y}`);
  assert.ok(bounds.max.x - bounds.min.x > 0.6, 'long arms should make the silhouette broad');
  assert.ok(bounds.max.z - bounds.min.z > 0.35, 'model should have full front-to-back volume');
  assert.ok(model.userData.nameplateY - 0.24 > bounds.max.y,
    'the 0.48-high token nameplate must clear the Ape model bounds');
});

test('all ape variations build with distinct fallback coats', async () => {
  const { ape } = await loadApeModel();
  const coatColors = new Set();
  for (const variant of ape.APE_VARIANTS) {
    const model = ape.createApeModel({ variant: variant.id, loadTextures: false });
    assert.equal(model.userData.monsterVariant, variant.id);
    assert.equal(model.userData.variantLabel, variant.label);
    const coat = model.getObjectByName('ApeRibcage');
    assert.ok(coat?.material?.isMeshStandardMaterial);
    coatColors.add(coat.material.color.getHex());
  }
  assert.equal(coatColors.size, ape.APE_VARIANTS.length);
});

test('ape disposal releases owned geometry and materials without texture ownership', async () => {
  const { ape } = await loadApeModel();
  const model = ape.createApeModel({ variant: 'highland', loadTextures: false });
  const geometries = new Set();
  const materials = new Set();
  let geometryDisposals = 0;
  let materialDisposals = 0;
  model.traverse(object => {
    if (object.userData?.ownGeometry && object.geometry && !geometries.has(object.geometry)) {
      geometries.add(object.geometry);
      object.geometry.addEventListener('dispose', () => geometryDisposals++);
    }
    const ownMaterials = Array.isArray(object.material) ? object.material : [object.material];
    ownMaterials.filter(Boolean).forEach(item => {
      if (materials.has(item)) return;
      materials.add(item);
      item.addEventListener('dispose', () => materialDisposals++);
    });
  });

  ape.disposeApeModel(model);
  assert.equal(model.userData.disposed, true);
  assert.equal(geometryDisposals, geometries.size);
  assert.equal(materialDisposals, materials.size);
  ape.disposeApeModel(model);
  assert.equal(geometryDisposals, geometries.size, 'cleanup should be idempotent');

  const callbackModel = ape.createApeModel({ loadTextures: false });
  callbackModel.userData.onDispose();
  assert.equal(callbackModel.userData.disposed, true);
});
