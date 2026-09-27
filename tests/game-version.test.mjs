import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gameVersion } from '../lib/game-version.mjs';

test('reads the full version and its major minor prefix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'refs-'));
  await writeFile(join(dir, 'Version.txt'), '1.6.4633 rev1254\n');

  assert.deepEqual(await gameVersion(dir), { full: '1.6.4633 rev1254', short: '1.6' });
});

test('a missing Version.txt is an error rather than an unknown string', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'refs-'));
  await assert.rejects(() => gameVersion(dir), /no Version.txt/);
});

test('a Version.txt that is not a version is an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'refs-'));
  await writeFile(join(dir, 'Version.txt'), 'not a version\n');
  await assert.rejects(() => gameVersion(dir), /unreadable/);
});

test('a bare major minor Version.txt reads, because gamecrate accepts one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'refs-'));
  await writeFile(join(dir, 'Version.txt'), '1.6\n');

  assert.deepEqual(await gameVersion(dir), { full: '1.6', short: '1.6' });
});

test('a second line stays out of the full version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'refs-'));
  await writeFile(join(dir, 'Version.txt'), '1.5.4243 rev999\nsomething else\n');

  assert.deepEqual(await gameVersion(dir), { full: '1.5.4243 rev999', short: '1.5' });
});

test('a leading blank line reads, because gamecrate trims before it matches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'refs-'));
  await writeFile(join(dir, 'Version.txt'), '\n1.6.4633 rev1254\n');

  assert.deepEqual(await gameVersion(dir), { full: '1.6.4633 rev1254', short: '1.6' });
});
