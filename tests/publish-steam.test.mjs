import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findSteamPlugin, publishSteam, splitPublish, stageFromDir } from '../lib/publish-steam.mjs';

const STEAM = 'semantic-release-steam';
const EXEC = '@semantic-release/exec';

async function configFile(source) {
  const dir = await mkdtemp(join(tmpdir(), 'publish-steam-'));
  const path = join(dir, 'release.config.mjs');
  await writeFile(path, source);
  return path;
}

test('the steam options come back whether the entry is a tuple or a bare name', () => {
  assert.deepEqual(findSteamPlugin([[STEAM, { appId: '294100' }]]), { appId: '294100' });
  assert.deepEqual(findSteamPlugin([STEAM]), {});
  assert.deepEqual(findSteamPlugin([[STEAM]]), {});
  assert.equal(findSteamPlugin(['@semantic-release/github']), null);
  assert.equal(findSteamPlugin(), null);
});

test('splitPublish is a no-op unless it is turned on', () => {
  const plugins = [[STEAM, { appId: '1' }], [EXEC, { prepareCmd: 'build', publishCmd: 'push' }]];
  assert.deepEqual(splitPublish(plugins, { enabled: false }), plugins);
});

test('splitPublish drops the steam plugin and keeps prepareCmd', () => {
  const split = splitPublish(
    [
      '@semantic-release/commit-analyzer',
      [EXEC, { prepareCmd: 'build', publishCmd: 'push' }],
      [STEAM, { appId: '294100' }],
      ['@semantic-release/github', { assets: [] }],
    ],
    { enabled: true },
  );

  assert.equal(findSteamPlugin(split), null);
  assert.deepEqual(
    split.map((e) => (Array.isArray(e) ? e[0] : e)),
    ['@semantic-release/commit-analyzer', EXEC, '@semantic-release/github'],
  );
  assert.deepEqual(split.find((e) => e[0] === EXEC)[1], { prepareCmd: 'build' });
});

test('splitPublish leaves an exec with no publishCmd alone', () => {
  const exec = [EXEC, { prepareCmd: 'build' }];
  assert.deepEqual(splitPublish([exec], { enabled: true }), [exec]);
});

test('the env flag turns splitPublish on', () => {
  const plugins = [[STEAM, {}]];
  process.env.SPLIT_PUBLISH = '1';
  try {
    assert.deepEqual(splitPublish(plugins), []);
  } finally {
    delete process.env.SPLIT_PUBLISH;
  }
  assert.deepEqual(splitPublish(plugins), plugins);
});

test('publishSteam hands the plugin its own options and a tagged-release context', async () => {
  const path = await configFile(
    `export default { plugins: [['semantic-release-steam', {
       appId: '294100',
       branchTargets: { main: 'stable' },
       mods: [{ name: 'RimLogging', workshopIds: { stable: '3733484696' } }],
     }]] };`,
  );

  const calls = [];
  const names = await publishSteam({
    configPath: path,
    version: '3.1.3',
    notes: 'the notes',
    branch: 'main',
    publish: (pluginConfig, context) => calls.push({ pluginConfig, context }),
  });

  assert.deepEqual(names, ['RimLogging']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pluginConfig.appId, '294100');
  assert.deepEqual(calls[0].context.branch, { name: 'main' });
  assert.deepEqual(calls[0].context.nextRelease, { version: '3.1.3', notes: 'the notes' });
  assert.equal(calls[0].context.options.dryRun, false);
});

test('publishSteam reads the config with SPLIT_PUBLISH cleared', async () => {
  const path = await configFile(
    `const split = process.env.SPLIT_PUBLISH === '1';
     const steam = ['semantic-release-steam', {
       branchTargets: { main: 'stable' },
       mods: [{ name: 'Mod', workshopIds: { stable: '1' } }],
     }];
     export default { plugins: split ? [] : [steam] };`,
  );

  process.env.SPLIT_PUBLISH = '1';
  try {
    const names = await publishSteam({
      configPath: path,
      version: '1.0.0',
      branch: 'main',
      publish: () => {},
    });
    assert.deepEqual(names, ['Mod']);
  } finally {
    delete process.env.SPLIT_PUBLISH;
  }
});

test('a staged copy is found by mod name, for a repo-root mod and a subdirectory one', () => {
  const stage = stageFromDir({
    mods: [
      { name: 'RimLogging', path: '.' },
      { name: 'CosmereCore', path: 'CosmereCore' },
    ],
    stageDir: '/tmp/zips',
    cwd: '/repo',
  });

  assert.equal(stage({ modPath: '/repo' }), '/tmp/zips/RimLogging');
  assert.equal(stage({ modPath: '/repo/CosmereCore' }), '/tmp/zips/CosmereCore');
  assert.throws(() => stage({ modPath: '/repo/Nope' }), /no staged copy/);
});

test('publishSteam stages from the release zips instead of the working tree', async () => {
  const path = await configFile(
    `export default { plugins: [['semantic-release-steam', { mods: [{ name: 'RimLogging', path: '.' }] }]] };`,
  );

  let staged;
  await publishSteam({
    configPath: path,
    version: '3.1.3',
    branch: 'main',
    cwd: '/repo',
    stageDir: '/tmp/zips',
    publish: (_config, context) => {
      staged = context.stageModContent({ modPath: '/repo' });
    },
  });

  assert.equal(staged, '/tmp/zips/RimLogging');
});

test('publishSteam leaves staging to the plugin when no stage dir is given', async () => {
  const path = await configFile(
    `export default { plugins: [['semantic-release-steam', { mods: [{ name: 'Mod', path: '.' }] }]] };`,
  );

  let context;
  await publishSteam({
    configPath: path,
    version: '1.0.0',
    branch: 'main',
    publish: (_config, ctx) => {
      context = ctx;
    },
  });

  assert.equal('stageModContent' in context, false);
});

test('publishSteam reports only the mods the branch target can reach', async () => {
  const path = await configFile(
    `export default { plugins: [['semantic-release-steam', {
       branchTargets: { main: 'stable', beta: 'beta' },
       mods: [
         { name: 'CosmereCore', workshopIds: { stable: '1', beta: '2' } },
         { name: 'CosmereRoshar', workshopIds: { beta: '3' } },
       ],
     }]] };`,
  );
  const common = { configPath: path, version: '9.9.9', publish: () => {} };

  assert.deepEqual(await publishSteam({ ...common, branch: 'main' }), ['CosmereCore']);
  assert.deepEqual(await publishSteam({ ...common, branch: 'beta' }), [
    'CosmereCore',
    'CosmereRoshar',
  ]);
  assert.deepEqual(await publishSteam({ ...common, branch: 'alpha' }), []);
});

test('publishSteam refuses a config with no steam plugin', async () => {
  const path = await configFile(`export default { plugins: ['@semantic-release/github'] };`);

  await assert.rejects(
    publishSteam({ configPath: path, version: '1.0.0', branch: 'main', publish: () => {} }),
    /no semantic-release-steam plugin/,
  );
});

test('publishSteam requires a version and a branch', async () => {
  await assert.rejects(
    publishSteam({ configPath: 'release.config.mjs', branch: 'main' }),
    /version is required/,
  );
  await assert.rejects(
    publishSteam({ configPath: 'release.config.mjs', version: '1.0.0' }),
    /branch is required/,
  );
});
