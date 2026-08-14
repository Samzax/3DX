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

module.exports = { loadStructuresModule };
