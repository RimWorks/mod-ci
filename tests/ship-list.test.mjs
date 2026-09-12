import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { shippedPaths, missingFromReleaseZip } from '../lib/ship-list.mjs';

const RIMLOGGING_BROKEN =
  "prepareCmd: 'mkdir -p dist/RimLogging && cp -r About Assemblies Concord Defs Harmony Languages loadFolders.xml LICENSE README.md dist/RimLogging/ && cd dist && zip -qr out.zip RimLogging'";

const RIMLOGGING_FIXED = RIMLOGGING_BROKEN.replace('Languages loadFolders.xml', 'Languages Textures loadFolders.xml');

async function repoWith(config, dirs) {
  const root = await mkdtemp(join(tmpdir(), 'shiplist-'));
  await writeFile(join(root, 'release.config.mjs'), config);
  for (const d of dirs) await mkdir(join(root, d), { recursive: true });
  return root;
}

test('reads the copied paths out of the cp step', () => {
  assert.deepEqual(shippedPaths(RIMLOGGING_BROKEN).slice(0, 3), ['About', 'Assemblies', 'Concord']);
});

test('a config with no cp step is not a failure', () => {
  assert.equal(shippedPaths('prepareCmd: "dotnet pack"'), null);
});

test('catches the Textures folder RimLogging shipped without for 8 releases', async () => {
  const root = await repoWith(RIMLOGGING_BROKEN, ['About', 'Defs', 'Languages', 'Textures']);
  const { missing } = await missingFromReleaseZip(root);
  assert.deepEqual(missing, ['Textures']);
});

test('passes once the cp step copies Textures', async () => {
  const root = await repoWith(RIMLOGGING_FIXED, ['About', 'Defs', 'Languages', 'Textures']);
  const { missing } = await missingFromReleaseZip(root);
  assert.deepEqual(missing, []);
});

test('a directory the repo does not have is not reported missing', async () => {
  const root = await repoWith(RIMLOGGING_FIXED, ['About']);
  const { missing } = await missingFromReleaseZip(root);
  assert.deepEqual(missing, []);
});

test('a repo with no release config is an error, not a silent pass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiplist-'));
  await assert.rejects(() => missingFromReleaseZip(root), /no release.config.mjs/);
});

const PICKLE_ZIP =
  'zip -r Pickle-${nextRelease.version}.zip About Assemblies Harmony Concord Languages Pickle loadFolders.xml -x "*.pdb" "About/Preview.xcf"';

test('reads the zip -r form the other three repos use', () => {
  assert.deepEqual(shippedPaths(PICKLE_ZIP), [
    'About', 'Assemblies', 'Harmony', 'Concord', 'Languages', 'Pickle', 'loadFolders.xml',
  ]);
});

test('the -x exclusions are not mistaken for shipped paths', () => {
  assert.ok(!shippedPaths(PICKLE_ZIP).includes('*.pdb'));
});

test('catches the Defs and Patches Pickle omits from its zip', async () => {
  const root = await repoWith(PICKLE_ZIP, ['About', 'Defs', 'Languages', 'Patches']);
  const { missing } = await missingFromReleaseZip(root);
  assert.deepEqual(missing, ['Defs', 'Patches']);
});

test('every read stays inside the root it was given', async () => {
  const root = await repoWith(PICKLE_ZIP, ['About', 'Defs']);
  const { missing } = await missingFromReleaseZip(`${root}${sep}About${sep}..`);
  assert.deepEqual(missing, ['Defs']);
});

test('a plain relative path still reads the repo it points at', async () => {
  const root = await repoWith(PICKLE_ZIP, ['About', 'Defs']);
  const back = process.cwd();
  process.chdir(root);
  try {
    const { missing } = await missingFromReleaseZip('.');
    assert.deepEqual(missing, ['Defs']);
  } finally {
    process.chdir(back);
  }
});
