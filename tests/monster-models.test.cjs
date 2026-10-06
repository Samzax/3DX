// Manifest-driven monster models: generator ↔ manifest ↔ client contract.
//
// The shared modules are ESM but package.json has no "type": "module", so they
// are loaded through vm.SourceTextModule (same pattern as ape-model.test.cjs,
// with a recursive linker for the generators' relative imports).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const sharedDir = path.join(repoRoot, 'public', 'js', 'shared');
const threePath = path.join(repoRoot, 'public', 'vendor', 'three', 'three.module.js');
const manifestPath = path.join(repoRoot, 'public', 'assets', 'monsters', 'manifest.json');
const toolPath = path.join(repoRoot, 'tools', 'gen-monster-manifest.mjs');
const gltfMapPath = path.join(repoRoot, 'tools', 'gltf-model-map.json');
const glbDir = path.join(repoRoot, 'public', 'assets', 'monsters', 'glbs');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const srd = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'srd', 'monsters.json'), 'utf8'));

// Addon specifiers as the importmap resolves them in the browser shells.
const ADDONS = {
    'three/addons/loaders/GLTFLoader.js': path.join(repoRoot, 'public', 'vendor', 'three', 'loaders', 'GLTFLoader.js'),
    'three/addons/utils/SkeletonUtils.js': path.join(repoRoot, 'public', 'vendor', 'three', 'utils', 'SkeletonUtils.js')
};

let sharedPromise = null;
function loadShared() {
    if (!sharedPromise) sharedPromise = loadSharedModules();
    return sharedPromise;
}

async function loadSharedModules() {
    const context = vm.createContext({ console });
    const options = { context };
    const modules = new Map();

    const load = filename => {
        if (modules.has(filename)) return modules.get(filename);
        const module = new vm.SourceTextModule(fs.readFileSync(filename, 'utf8'), {
            ...options,
            identifier: pathToFileURL(filename).href
        });
        modules.set(filename, module);
        return module;
    };

    const link = async module => {
        if (module.status !== 'unlinked') return;
        await module.link(async specifier => {
            if (specifier === 'three') {
                const dependency = load(threePath);
                await link(dependency);
                return dependency;
            }
            if (Object.prototype.hasOwnProperty.call(ADDONS, specifier)) {
                const dependency = load(ADDONS[specifier]);
                await link(dependency);
                return dependency;
            }
            if (specifier.startsWith('./') || specifier.startsWith('../')) {
                const resolved = path.resolve(path.dirname(fileURLToPath(module.identifier)), specifier);
                const dependency = load(resolved);
                await link(dependency);
                return dependency;
            }
            throw new Error(`unexpected import: ${specifier} from ${module.identifier}`);
        });
    };

    const entry = load(path.join(sharedDir, 'monster-models.js'));
    await link(entry);
    const three = load(threePath);
    await link(three);
    for (const module of modules.values()) {
        if (module.status === 'linked') await module.evaluate();
    }

    const namespace = name => modules.get(path.join(sharedDir, name)).namespace;
    return {
        models: entry.namespace,
        generators: namespace('monster-generators.js'),
        monsters: namespace('monsters.js'),
        three: three.namespace
    };
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

test('manifest generator plan list stays in sync with monster-generators.js', async () => {
    const { generators } = await loadShared();
    const toolSource = fs.readFileSync(toolPath, 'utf8');
    const block = toolSource.match(/const PLAN_NAMES = \[([\s\S]*?)\];/);
    assert.ok(block, 'PLAN_NAMES block missing from tools/gen-monster-manifest.mjs');
    const toolPlans = [...block[1].matchAll(/'([a-z]+)'/g)].map(match => match[1]);
    assert.deepEqual(
        [...toolPlans].sort(),
        [...generators.PLAN_NAMES].sort(),
        'tool PLAN_NAMES must match the exported plan builders'
    );
    assert.equal(new Set(toolPlans).size, toolPlans.length, 'duplicate plan in tool list');
});

test('committed manifest matches the generator (no drift)', () => {
    execFileSync(process.execPath, [toolPath, '--check'], { cwd: repoRoot, stdio: 'pipe' });
});

test('manifest covers every SRD monster with a sane contract', async () => {
    const { generators } = await loadShared();
    const planNames = new Set(generators.PLAN_NAMES);
    const sizes = new Set(['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan']);

    assert.equal(manifest.version, 1);
    assert.equal(manifest.count, srd.length);
    const keys = Object.keys(manifest.monsters);
    assert.equal(keys.length, srd.length, 'one entry per SRD monster');
    assert.deepEqual(new Set(keys), new Set(srd.map(record => record.index)), 'index sets must match the SRD');

    for (const record of srd) {
        const entry = manifest.monsters[record.index];
        assert.ok(entry, `missing entry for ${record.index}`);
        assert.equal(entry.index, record.index);
        assert.equal(entry.name, record.name);
        assert.ok(entry.kind === 'procedural' || entry.kind === 'gltf', `${record.index}: unknown kind ${entry.kind}`);
        assert.ok(entry.height >= 0.1 && entry.height <= 12, `${record.index}: height ${entry.height}`);
        assert.ok(entry.nameplateY >= 0.72 && entry.nameplateY <= 20, `${record.index}: nameplateY ${entry.nameplateY}`);
        assert.equal(
            entry.nameplateY,
            Math.round(Math.max(0.72, entry.height + 0.42) * 100) / 100,
            `${record.index}: nameplateY must clear the model by 0.42`
        );
        assert.ok(sizes.has(entry.provenance.size), `${record.index}: provenance size`);
        if (entry.kind === 'gltf') {
            assert.match(entry.url, /^\/assets\/monsters\/glbs\/[a-z0-9-]+\.glb$/i, `${record.index}: gltf url`);
            assert.equal(entry.plan, undefined, `${record.index}: gltf entry must not carry a plan`);
            assert.equal(entry.params, undefined, `${record.index}: gltf entry must not carry params`);
            assert.equal(entry.variants, undefined, `${record.index}: gltf entry must not carry variants`);
            assert.match(entry.provenance.rule, /^gltf:[a-z0-9-]+\.glb$/i, `${record.index}: provenance rule`);
        } else {
            assert.ok(planNames.has(entry.plan), `${record.index}: unknown plan ${entry.plan}`);
            assert.ok(entry.params && typeof entry.params === 'object', `${record.index}: params object`);
            for (const [key, value] of Object.entries(entry.params.colors || {})) {
                assert.match(String(value), HEX_COLOR, `${record.index}: colors.${key}`);
            }
            assert.match(entry.provenance.rule, /^(name|form|type):/, `${record.index}: provenance rule`);
        }
        if (entry.variants) {
            const seen = new Set();
            for (const variant of entry.variants) {
                assert.match(variant.id, /^[a-z0-9][a-z0-9_-]*$/i, `${record.index}: variant id`);
                assert.ok(!seen.has(variant.id), `${record.index}: duplicate variant id`);
                assert.ok(variant.label, `${record.index}: variant label`);
                seen.add(variant.id);
            }
        }
    }

    // The ape pilot's recorded contract: Medium, seated nameplate, 3 variants.
    const ape = manifest.monsters.ape;
    assert.equal(ape.plan, 'ape');
    assert.equal(ape.height, 1.1);
    assert.equal(ape.nameplateY, 1.52);
    assert.deepEqual(
        Array.from(ape.variants, variant => variant.id),
        ['silverback', 'highland', 'albino']
    );
    // Only the ape pilot ships variants for now.
    assert.deepEqual(
        keys.filter(key => manifest.monsters[key].variants),
        ['ape']
    );
});

test('every manifest entry builds a finite model near the ground', async () => {
    const { generators, three } = await loadShared();
    let built = 0;
    let gltf = 0;
    for (const [index, entry] of Object.entries(manifest.monsters)) {
        if (entry.kind === 'gltf') {
            // GLB entries skip the procedural builders; their file must be there.
            const file = path.join(glbDir, path.basename(entry.url));
            assert.ok(fs.existsSync(file), `${index}: missing GLB ${entry.url}`);
            assert.ok(fs.statSync(file).size > 1000, `${index}: implausibly small GLB ${entry.url}`);
            gltf++;
            continue;
        }
        const params = { ...entry.params };
        if (entry.plan === 'ape') {
            params.loadTextures = false;
            params.variant = 'silverback';
        }
        let model;
        try {
            model = generators.buildMonsterModel(entry.plan, params, {});
        } catch (error) {
            assert.fail(`${index} (${entry.plan}) failed to build: ${error.stack}`);
        }
        assert.ok(model, `${index}: no model`);

        let meshes = 0;
        model.traverse(object => { if (object.isMesh) meshes++; });
        // Swarms sketch one critter per color key, so the single-key snake
        // silhouette legitimately lands in a merged mesh.
        const minMeshes = entry.plan === 'swarm' ? 1 : 2;
        assert.ok(meshes >= minMeshes, `${index}: expected a body, got ${meshes} meshes`);

        const bounds = new three.Box3().setFromObject(model);
        for (const value of [bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z]) {
            assert.ok(Number.isFinite(value), `${index}: non-finite bounds`);
        }
        const height = bounds.max.y - bounds.min.y;
        assert.ok(height >= 0.1 && height <= 6, `${index}: raw height ${height.toFixed(2)} outside [0.1, 6]`);
        assert.ok(bounds.max.x - bounds.min.x <= 9, `${index}: raw width too large`);
        assert.ok(bounds.max.z - bounds.min.z <= 9, `${index}: raw depth too large`);
        assert.ok(Math.abs(bounds.min.y) <= 0.6, `${index}: raw model floats/sinks (minY=${bounds.min.y.toFixed(3)})`);
        built++;
    }
    assert.equal(built + gltf, srd.length);
    assert.ok(gltf > 0, 'expected at least one GLB-mapped monster');
});

test('gltf manifest entries mirror tools/gltf-model-map.json', () => {
    const map = JSON.parse(fs.readFileSync(gltfMapPath, 'utf8'));
    const mappedKeys = Object.keys(map).filter(key => !key.startsWith('$'));
    const gltfEntries = Object.keys(manifest.monsters)
        .filter(key => manifest.monsters[key].kind === 'gltf');
    assert.ok(mappedKeys.length > 0, 'gltf-model-map.json should map something');
    assert.deepEqual(new Set(gltfEntries), new Set(mappedKeys),
        'manifest gltf entries must match the map keys exactly');
    for (const key of mappedKeys) {
        const entry = manifest.monsters[key];
        const mapped = map[key];
        assert.equal(entry.url, `/assets/monsters/glbs/${mapped.f}`, `${key}: url`);
        assert.equal(entry.height, Math.round(Number(mapped.h) * 100) / 100, `${key}: height`);
        const file = path.join(glbDir, mapped.f);
        assert.ok(fs.existsSync(file), `${key}: missing GLB ${mapped.f}`);
        assert.ok(fs.statSync(file).size > 1000, `${key}: implausibly small GLB ${mapped.f}`);
    }
});

test('token groups: idle fallback, adopted manifest, seat and metadata', async () => {
    const { models, monsters, three } = await loadShared();
    const noDisc = () => {
        throw new Error('makeDisc must not run when a model can be built');
    };
    const tokenData = index => ({
        monsterData: { index, size: 'Medium', type: 'beast' }
    });

    // Before the manifest lands only the built-in ape pilot renders a model.
    const idleApe = models.createMonsterTokenGroup(tokenData('ape'), noDisc);
    assert.ok(idleApe, 'idle ape should use the built-in fallback entry');
    assert.equal(idleApe.userData.monsterPlan, 'ape');
    idleApe.userData.onDispose();
    assert.equal(idleApe.userData.disposed, true);
    assert.equal(
        models.createMonsterTokenGroup(tokenData('wolf'), noDisc),
        null,
        'idle non-ape monsters keep their disc'
    );
    assert.equal(models.createMonsterTokenGroup({ monsterData: { index: '' } }, noDisc), null);

    const adopted = models.adoptMonsterManifest(manifest);
    assert.equal(adopted.version, 1);
    assert.equal(Object.keys(adopted.monsters).length, srd.length);

    for (const index of ['ape', 'wolf', 'adult-red-dragon', 'swarm-of-bats', 'dragon-turtle', 'skeleton', 'tyrannosaurus-rex']) {
        if (manifest.monsters[index].kind === 'gltf') {
            // No DOM in tests: GLB entries keep the caller's disc.
            assert.equal(
                models.createMonsterTokenGroup(tokenData(index), noDisc),
                null,
                `${index}: gltf entry must return null (disc fallback) in Node`
            );
            continue;
        }
        const wrapper = models.createMonsterTokenGroup(tokenData(index), noDisc);
        assert.ok(wrapper, `${index}: expected a model, got null`);
        assert.ok(wrapper.getObjectByName(`MonsterModel:${index}`), `${index}: missing holder group`);
        assert.equal(wrapper.userData.monsterIndex, index);
        assert.equal(wrapper.userData.halfHeight, models.TOKEN_HALF_HEIGHT);
        assert.equal(wrapper.userData.halfHeight, 0.1, 'stored token positions must not migrate');
        assert.equal(wrapper.userData.monsterHeight, manifest.monsters[index].height);
        assert.ok(wrapper.userData.nameplateY >= 0.72 && wrapper.userData.nameplateY <= 20);
        assert.ok(wrapper.userData.monsterScale >= 0.05 && wrapper.userData.monsterScale <= 20,
            `${index}: scale ${wrapper.userData.monsterScale}`);

        const bounds = new three.Box3().setFromObject(wrapper);
        assert.ok(
            Math.abs(bounds.min.y - models.TOKEN_SEAT_Y) < 0.03,
            `${index}: soles should sit at ${models.TOKEN_SEAT_Y}, got ${bounds.min.y.toFixed(3)}`
        );
        assert.ok(
            wrapper.userData.nameplateY - 0.24 > bounds.max.y,
            `${index}: nameplate must clear the model top (${bounds.max.y.toFixed(2)})`
        );

        wrapper.userData.onDispose();
        assert.equal(wrapper.userData.disposed, true);
    }

    // A variant-less procedural monster asks for no variant; only an ape does.
    const plain = models.createMonsterTokenGroup(tokenData('adult-red-dragon'), noDisc);
    assert.equal(plain.userData.monsterVariant, undefined);
    plain.userData.onDispose();

    // The variant rides next to monsterData on the saved token (see gm.js).
    const apeData = {
        monsterData: { index: 'ape', size: 'Medium', type: 'beast' },
        monsterVariant: 'albino'
    };
    const ape = models.createMonsterTokenGroup(apeData, noDisc);
    assert.equal(ape.userData.monsterVariant, 'albino');
    ape.userData.onDispose();

    assert.equal(models.createMonsterTokenGroup(tokenData('no-such-monster'), noDisc), null);

    // Variant catalog flows from the manifest into the shared helpers.
    assert.deepEqual(
        Array.from(monsters.monsterAppearanceVariants({ index: 'ape' }), variant => variant.id),
        ['silverback', 'highland', 'albino']
    );
    assert.equal(monsters.monsterAppearanceVariant({ index: 'ape' }, ' ALBINO '), 'albino');
    // Cross-realm array from the vm module: compare by length, not reference.
    assert.equal(monsters.monsterAppearanceVariants({ index: 'wolf' }).length, 0);
});
