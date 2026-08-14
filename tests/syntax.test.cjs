const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

function javascriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...javascriptFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(fullPath);
  }
  return files.sort();
}

function checkSyntax(filename) {
  const result = spawnSync(process.execPath, ['--check', filename], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  const relative = path.relative(repoRoot, filename);
  assert.equal(
    result.status,
    0,
    `${relative} failed node --check\n${result.stderr || result.stdout}`
  );
}

test('server parses as CommonJS', () => {
  checkSyntax(path.join(repoRoot, 'server.js'));
});

test('browser JavaScript modules parse', () => {
  const files = javascriptFiles(path.join(repoRoot, 'public'));
  assert.ok(files.length > 0, 'expected browser JavaScript files');
  for (const filename of files) checkSyntax(filename);
});
