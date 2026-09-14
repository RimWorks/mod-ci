import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { packageMod } from '../lib/package-mod.mjs';

const run = promisify(execFile);

async function fakeMod() {
  const root = await mkdtemp(join(tmpdir(), 'mod-ci-test-'));
  for (const dir of ['About', 'Assemblies', 'Textures', 'Source', 'obj']) {
    await mkdir(join(root, dir));
    await writeFile(join(root, dir, 'file.txt'), dir);
  }
  await writeFile(join(root, 'About', 'About.xml'), '<ModMetaData />');
  await writeFile(join(root, 'LICENSE'), 'MIT');
  await writeFile(join(root, 'README.md'), '# MyMod');
  await writeFile(join(root, '.steamignore'), 'Source\nobj\ndist\n*.md\n');
  return root;
}

test('ships everything .steamignore does not exclude', async (t) => {
  const root = await fakeMod();
  t.after(() => rm(root, { recursive: true, force: true }));

  const { entries } = await packageMod({ name: 'MyMod', version: '1.2.3', modPath: root });

  assert.deepEqual(entries, ['About', 'Assemblies', 'LICENSE', 'README.md', 'Textures']);
});

test('keeps the readme steam drops', async (t) => {
  const root = await fakeMod();
  t.after(() => rm(root, { recursive: true, force: true }));

  const { entries } = await packageMod({ name: 'MyMod', version: '1.2.3', modPath: root });

  assert.ok(entries.includes('README.md'));
});

test('wraps the zip in a folder named after the mod', async (t) => {
  const root = await fakeMod();
  t.after(() => rm(root, { recursive: true, force: true }));

  const { zipPath } = await packageMod({ name: 'MyMod', version: '1.2.3', modPath: root });
  const { stdout } = await run('unzip', ['-Z1', zipPath]);

  assert.ok(zipPath.endsWith('dist/MyMod-1.2.3.zip'));
  assert.ok(stdout.split('\n').filter(Boolean).every((line) => line.startsWith('MyMod/')));
});

test('never ships the output directory', async (t) => {
  const root = await fakeMod();
  t.after(() => rm(root, { recursive: true, force: true }));

  await packageMod({ name: 'MyMod', version: '1.2.3', modPath: root });
  const { entries } = await packageMod({ name: 'MyMod', version: '1.2.4', modPath: root });

  assert.ok(!entries.includes('dist'));
});

test('refuses a directory that is not a mod', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mod-ci-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.steamignore'), 'obj\n');

  await assert.rejects(packageMod({ name: 'MyMod', version: '1.2.3', modPath: root }), /About\/About\.xml/);
});

test('refuses a repo with no .steamignore', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mod-ci-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(packageMod({ name: 'MyMod', version: '1.2.3', modPath: root }), /no \.steamignore/);
});
