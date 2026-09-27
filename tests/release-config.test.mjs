import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MOD_RELEASE_RULES,
  VERSION_ARGS,
  buildVersions,
  nugetPush,
  refsDirFor,
  steamMod,
} from '../lib/release-config.mjs';

const clearRefsEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GAME_MANAGED_')) delete process.env[key];
  }
  delete process.env.GameManagedDir;
};

test('a staged version dir wins over the gamecrate cache', () => {
  clearRefsEnv();
  process.env.GAME_MANAGED_1_6 = '/runner/game/Managed';
  try {
    assert.equal(refsDirFor('1.6'), '/runner/game/Managed');
    assert.match(refsDirFor('1.5'), /gamecrate\/refs\/version\/rimworld\/1\.5$/);
  } finally {
    clearRefsEnv();
  }
});

test('a single-version leg falls back to GameManagedDir', () => {
  clearRefsEnv();
  process.env.GameManagedDir = '/runner/only/Managed';
  try {
    assert.equal(refsDirFor('1.6'), '/runner/only/Managed');
  } finally {
    clearRefsEnv();
  }
});

test('builds one command per version, each naming its own refs', () => {
  clearRefsEnv();
  const cmds = buildVersions({ solution: 'Pickle.slnx', versions: ['1.5', '1.6'] });

  assert.equal(cmds.length, 2);
  assert.match(cmds[0], /-p:GameVersion=1\.5 -p:GameManagedDir=.*rimworld\/1\.5$/);
  assert.match(cmds[1], /-p:GameVersion=1\.6 -p:GameManagedDir=.*rimworld\/1\.6$/);
  assert.ok(cmds.every((c) => c.includes(VERSION_ARGS)));
});

test('an empty version list is an error rather than a build that ships nothing', () => {
  assert.throws(() => buildVersions({ solution: 'x.slnx', versions: [] }), /no versions/);
  assert.throws(() => buildVersions({ versions: ['1.6'] }), /solution is required/);
});

test('no workshop id yields no steam plugin at all', () => {
  assert.deepEqual(steamMod({ name: 'Pickle', workshopId: '' }), []);
});

test('a preview file is only written when one is given', () => {
  const [[, opts]] = steamMod({ name: 'Pickle', workshopId: '123' });
  assert.equal('previewfile' in opts.mods[0], false);

  const [[, withPreview]] = steamMod({ name: 'Pickle', workshopId: '123', previewfile: '/p.png' });
  assert.equal(withPreview.mods[0].previewfile, '/p.png');
});

test('the nuget push skips itself without a key, so a dry run does not fail', () => {
  const cmd = nugetPush('artifacts/Foo.*.nupkg');
  assert.match(cmd, /if \[ -n "\$NUGET_API_KEY" \]/);
  assert.match(cmd, /--skip-duplicate/);
  assert.match(cmd, /else echo/);
});

test('the release rules cover the types that are shipped content', () => {
  const types = MOD_RELEASE_RULES.map((r) => r.type);
  assert.deepEqual(types, ['refactor', 'style', 'ci', 'docs']);
  assert.ok(MOD_RELEASE_RULES.every((r) => r.release === 'patch'));
});
