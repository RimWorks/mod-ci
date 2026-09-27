import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { declaredVersions, versionFolderMismatch } from '../lib/ship-list.mjs';

const PICKLE_LOAD_FOLDERS = `<?xml version="1.0" encoding="utf-8"?>
<loadFolders>
  <v1.5>
    <li>/</li>
    <li>1.5</li>
    <li IfModActive="brrainz.harmony">1.5/Harmony</li>
  </v1.5>
  <v1.6>
    <li>/</li>
    <li>1.6</li>
    <li IfModActive="concordlib.concord">1.6/Concord</li>
  </v1.6>
</loadFolders>`;

async function repoWith(loadFolders, dirs) {
  const root = await mkdtemp(join(tmpdir(), 'shiplist-'));
  await writeFile(join(root, 'loadFolders.xml'), loadFolders);
  for (const d of dirs) await mkdir(join(root, d), { recursive: true });
  return root;
}

test('reads every version block, and the per-backend paths inside are not versions', () => {
  assert.deepEqual(declaredVersions(PICKLE_LOAD_FOLDERS), ['1.5', '1.6']);
});

test('a matching set of folders passes', async () => {
  const root = await repoWith(PICKLE_LOAD_FOLDERS, ['1.5', '1.6', 'About']);
  const { missing, undeclared } = await versionFolderMismatch(root);
  assert.deepEqual([missing, undeclared], [[], []]);
});

test('a version loadFolders claims with no folder built is reported', async () => {
  const root = await repoWith(PICKLE_LOAD_FOLDERS, ['1.6']);
  const { missing, undeclared } = await versionFolderMismatch(root);
  assert.deepEqual(missing, ['1.5']);
  assert.deepEqual(undeclared, []);
});

test('a bare checkout reports every claimed version, it does not pass', async () => {
  const root = await repoWith(PICKLE_LOAD_FOLDERS, ['About', 'Defs']);
  const { missing } = await versionFolderMismatch(root);
  assert.deepEqual(missing, ['1.5', '1.6']);
});

test('a folder on disk no version block claims is reported', async () => {
  const root = await repoWith(PICKLE_LOAD_FOLDERS, ['1.4', '1.5', '1.6']);
  const { missing, undeclared } = await versionFolderMismatch(root);
  assert.deepEqual(missing, []);
  assert.deepEqual(undeclared, ['1.4']);
});

test('both directions report at once', async () => {
  const root = await repoWith(PICKLE_LOAD_FOLDERS, ['1.6', '1.9']);
  const { missing, undeclared } = await versionFolderMismatch(root);
  assert.deepEqual([missing, undeclared], [['1.5'], ['1.9']]);
});

test('a repo with no loadFolders.xml is an error, not a silent pass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiplist-'));
  await assert.rejects(() => versionFolderMismatch(root), /no loadFolders.xml/);
});

test('a loadFolders.xml with no version block is an error, not a vacuous pass', async () => {
  const root = await repoWith('<loadFolders></loadFolders>', ['1.6']);
  await assert.rejects(() => versionFolderMismatch(root), /no <vX\.Y> block/);
});

test('every read stays inside the root it was given', async () => {
  const root = await repoWith(PICKLE_LOAD_FOLDERS, ['About', '1.5']);
  const { missing } = await versionFolderMismatch(`${root}${sep}About${sep}..`);
  assert.deepEqual(missing, ['1.6']);
});

test('a plain relative path still reads the repo it points at', async () => {
  const root = await repoWith(PICKLE_LOAD_FOLDERS, ['1.5']);
  const back = process.cwd();
  process.chdir(root);
  try {
    const { missing } = await versionFolderMismatch('.');
    assert.deepEqual(missing, ['1.6']);
  } finally {
    process.chdir(back);
  }
});

test('sorts versions numerically, so at(-1) is the newest once 1.10 exists', () => {
  const xml = '<loadFolders><v1.5><li>1.5</li></v1.5><v1.10><li>1.10</li></v1.10>'
    + '<v1.6><li>1.6</li></v1.6><v1.9><li>1.9</li></v1.9></loadFolders>';
  const versions = declaredVersions(xml);

  assert.deepEqual(versions, ['1.5', '1.6', '1.9', '1.10']);
  assert.equal(versions.at(-1), '1.10');
});
