import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MOD_RELEASE_RULES,
  VERSION_ARGS,
  buildVersions,
  nugetPush,
  refsDirFor,
  releaseConfig,
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

test('a shared GameManagedDir across versions is refused, not silently reused', () => {
  clearRefsEnv();
  process.env.GameManagedDir = '/runner/game-1.6/Managed';
  try {
    assert.throws(
      () => buildVersions({ solution: 'x.slnx', versions: ['1.5', '1.6'] }),
      /GAME_MANAGED_1_5 or GAME_MANAGED_1_6/,
    );

    // once each version is staged by name, the same call is fine
    process.env.GAME_MANAGED_1_5 = '/runner/game-1.5/Managed';
    process.env.GAME_MANAGED_1_6 = '/runner/game-1.6/Managed';
    const cmds = buildVersions({ solution: 'x.slnx', versions: ['1.5', '1.6'] });
    assert.match(cmds[0], /GameManagedDir=\/runner\/game-1\.5\/Managed/);
    assert.match(cmds[1], /GameManagedDir=\/runner\/game-1\.6\/Managed/);
  } finally {
    clearRefsEnv();
  }
});

test('one version with GameManagedDir is still allowed', () => {
  clearRefsEnv();
  process.env.GameManagedDir = '/runner/only/Managed';
  try {
    const [cmd] = buildVersions({ solution: 'x.slnx', versions: ['1.6'] });
    assert.match(cmd, /GameManagedDir=\/runner\/only\/Managed/);
  } finally {
    clearRefsEnv();
  }
});

const base = {
  solution: 'X.slnx',
  versions: ['1.5', '1.6'],
  mods: [{ name: 'X', workshopId: '1' }],
};

test('the prepare order builds before it stamps, and stamps before it zips', () => {
  clearRefsEnv();
  const cfg = releaseConfig(base);
  const exec = cfg.plugins.find((p) => Array.isArray(p) && p[0] === '@semantic-release/exec')[1];
  const steps = exec.prepareCmd.split(' && ');

  const build = steps.findLastIndex((s) => s.startsWith('dotnet build'));
  const stamp = steps.findIndex((s) => s.startsWith('npx write-stamp'));
  const zip = steps.findIndex((s) => s.startsWith('npx package-mod'));

  assert.ok(build < stamp, 'the stamp reads resolved versions, so it runs after the builds');
  assert.ok(stamp < zip, 'the stamp has to be in the zip');
});

test('a repo with no pack project gets no pack step and no publishCmd', () => {
  const cfg = releaseConfig(base);
  const exec = cfg.plugins.find((p) => Array.isArray(p) && p[0] === '@semantic-release/exec')[1];

  assert.equal(exec.prepareCmd.includes('dotnet pack'), false);
  assert.equal('publishCmd' in exec, false);
});

test('missing pieces are errors rather than a config that releases nothing', () => {
  assert.throws(() => releaseConfig({ ...base, solution: undefined }), /solution is required/);
  assert.throws(() => releaseConfig({ ...base, versions: [] }), /versions is required/);
  assert.throws(() => releaseConfig({ ...base, mods: [] }), /at least one mod/);
});

test('the returned config is plain, so a repo can override what it does not cover', () => {
  const cfg = releaseConfig(base);
  const mine = { ...cfg, branches: ['next'] };

  assert.deepEqual(mine.branches, ['next']);
  assert.equal(mine.plugins, cfg.plugins);
});
