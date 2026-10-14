const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

class StubBoxGeometry {}
class StubColor {}
class StubObject3D {}

/**
 * Load structures.js as an ES module without a DOM or WebGL context.
 *
 * The tests below exercise only its pure exported helpers. Three.js and
 * scene.js are represented by the three constructors/constants initialized at
 * module scope, making the test fail on the real helper source without asking
 * production code to grow a Node-specific entry point.
 */
async function loadStructuresModule(repoRoot) {
  const filename = path.join(repoRoot, 'public', 'js', 'shared', 'structures.js');
  const context = vm.createContext({ console });
  const options = { context };

  const three = new vm.SyntheticModule(
    ['BoxGeometry', 'Color', 'Object3D'],
    function initializeThreeStub() {
      this.setExport('BoxGeometry', StubBoxGeometry);
      this.setExport('Color', StubColor);
      this.setExport('Object3D', StubObject3D);
    },
    { ...options, identifier: 'three:test-stub' }
  );
  const scene = new vm.SyntheticModule(
    ['GRID_CELL_SIZE'],
    function initializeSceneStub() {
      this.setExport('GRID_CELL_SIZE', 1);
    },
    { ...options, identifier: 'scene:test-stub' }
  );
  const module = new vm.SourceTextModule(fs.readFileSync(filename, 'utf8'), {
    ...options,
    identifier: pathToFileURL(filename).href
  });

  await module.link((specifier) => {
    if (specifier === 'three') return three;
    if (specifier === './scene.js') return scene;
    throw new Error(`Unexpected structures.js import in test loader: ${specifier}`);
  });
  await module.evaluate();
  return module.namespace;
}

/**
 * Load terrain.js as an ES module headlessly in a node:vm context with real
 * vendored Three.js, worldgen.js, hexworld.js and ground.js dependencies.
 */
async function loadTerrainModule(repoRoot) {
  const terrainFilename = path.join(repoRoot, 'public', 'js', 'shared', 'terrain.js');
  const threeFilename = path.join(repoRoot, 'public', 'vendor', 'three', 'three.module.js');
  const worldgenFilename = path.join(repoRoot, 'public', 'js', 'shared', 'worldgen.js');
  const hexworldFilename = path.join(repoRoot, 'public', 'js', 'shared', 'hexworld.js');
  const groundFilename = path.join(repoRoot, 'public', 'js', 'shared', 'ground.js');

  const context = vm.createContext({
    console,
    Math,
    Object,
    Array,
    Map,
    Set,
    Float32Array,
    Uint8Array,
    Uint16Array,
    Int16Array
  });
  const options = { context };

  const threeModule = new vm.SourceTextModule(fs.readFileSync(threeFilename, 'utf8'), {
    ...options,
    identifier: pathToFileURL(threeFilename).href
  });
  await threeModule.link(() => {});
  await threeModule.evaluate();

  const worldgenModule = new vm.SourceTextModule(fs.readFileSync(worldgenFilename, 'utf8'), {
    ...options,
    identifier: pathToFileURL(worldgenFilename).href
  });
  await worldgenModule.link(() => {});
  await worldgenModule.evaluate();

  const hexworldModule = new vm.SourceTextModule(fs.readFileSync(hexworldFilename, 'utf8'), {
    ...options,
    identifier: pathToFileURL(hexworldFilename).href
  });
  await hexworldModule.link(() => {});
  await hexworldModule.evaluate();

  const groundModule = new vm.SourceTextModule(fs.readFileSync(groundFilename, 'utf8'), {
    ...options,
    identifier: pathToFileURL(groundFilename).href
  });
  await groundModule.link((specifier) => {
    if (specifier === './worldgen.js') return worldgenModule;
    if (specifier === './hexworld.js') return hexworldModule;
    throw new Error(`Unexpected ground.js import in test loader: ${specifier}`);
  });
  await groundModule.evaluate();

  const terrainModule = new vm.SourceTextModule(fs.readFileSync(terrainFilename, 'utf8'), {
    ...options,
    identifier: pathToFileURL(terrainFilename).href
  });

  await terrainModule.link((specifier) => {
    if (specifier === 'three') return threeModule;
    if (specifier === './worldgen.js') return worldgenModule;
    if (specifier === './hexworld.js') return hexworldModule;
    if (specifier === './ground.js') return groundModule;
    throw new Error(`Unexpected terrain.js import in test loader: ${specifier}`);
  });
  await terrainModule.evaluate();
  return terrainModule.namespace;
}

module.exports = { loadStructuresModule, loadTerrainModule };
