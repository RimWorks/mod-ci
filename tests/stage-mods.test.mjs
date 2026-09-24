import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = join(import.meta.dirname, '..', '.github', 'actions', 'pickle-run', 'stage-mods.sh');

// Every case here is refused before the first download, so the suite needs no network.
async function stage(env) {
  const root = await mkdtemp(join(tmpdir(), 'stage-mods-'));
  await mkdir(join(root, 'mod'));
  try {
    await run('bash', [script, 'harmony', join(root, 'mods'), join(root, 'config')], {
      cwd: root,
      env: { PATH: process.env.PATH, MOD_DIRS: 'mod:Mod', MOD_PACKAGE_ID: 'rimworks.example', ...env },
    });
  } catch (err) {
    return err.stderr;
  }
  throw new Error('expected the staging script to fail');
}

test('refuses a mod dir that is not there, before the game reads it as a missing def', async () => {
  assert.match(await stage({ MOD_DIRS: 'typo:Mod' }), /mod dir 'typo', mounted as 'Mod', does not exist/);
});

test('refuses a mod name pasted into the package id', async () => {
  assert.match(await stage({ MOD_PACKAGE_ID: 'Cosmere - Core' }), /has whitespace in it/);
});

test('refuses the old five field staged-mods entry', async () => {
  const stderr = await stage({ STAGED_MODS: 'owner/repo:Prefix:some.id:v1.2:deadbeef' });
  assert.match(stderr, /is not owner\/repo:AssetPrefix:packageId/);
});

test('refuses a repo root mount with nothing to name it', async () => {
  assert.match(await stage({ MOD_DIRS: '' }), /MOD_DIRS is empty and MOD_NAME is unset/);
});

test('refuses a mount that is a path rather than a folder name', async () => {
  assert.match(await stage({ MOD_DIRS: 'mod:../escape' }), /is a path, not a folder name/);
});

test('copies each mod dir into the mods directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stage-mods-'));
  await mkdir(join(root, 'mod', 'About'), { recursive: true });
  await writeFile(join(root, 'mod', 'About', 'About.xml'), '<ModMetaData />');
  await mkdir(join(root, 'mod', 'Source'), { recursive: true });
  await writeFile(join(root, 'mod', 'Source', 'Thing.cs'), '// not shipped');

  // A curl that always fails stops the run at the first download, after the copies have landed.
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'curl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

  await assert.rejects(run('bash', [script, 'harmony', join(root, 'mods'), join(root, 'config')], {
    cwd: root,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      MOD_DIRS: 'mod:Example',
      MOD_PACKAGE_ID: 'rimworks.example',
    },
  }));

  assert.ok(existsSync(join(root, 'mods', 'Example', 'About', 'About.xml')));
  assert.ok(!existsSync(join(root, 'mods', 'Example', 'Source')));
});
