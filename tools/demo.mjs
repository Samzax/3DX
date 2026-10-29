// demo.mjs — `npm run demo`: the showcase table, no setup.
//
// Builds the demo campaign (tools/build-demo.mjs) into data/demo the first
// time, then starts the ordinary server over that folder in open-login mode:
// sign in as `gm` to run the game or as `player` to play the party. Your own
// saves in data/saves are never touched. Delete data/demo to start over.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(process.env.THREEDX_DATA_DIR || path.join(ROOT, 'data', 'demo'));
if (!fs.existsSync(path.join(dir, 'campaigns.json'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-demo.mjs'), '--saves', dir], { stdio: 'inherit' });
}
process.env.THREEDX_DATA_DIR = dir;
process.env.THREEDX_OPEN_LOGIN = '1';
process.env.THREEDX_DEMO = '1';
createRequire(import.meta.url)(path.join(ROOT, 'server.js'));
