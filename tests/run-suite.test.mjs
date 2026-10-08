import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const actions = join(import.meta.dirname, '..', '.github', 'actions', 'pickle-run');
const scripts = {
  linux: join(actions, 'run-suite.sh'),
  windows: join(actions, 'run-suite-windows.sh'),
};

// A stub docker records the argv it was handed and returns whatever exit code the case wants,
// so nothing here pulls an image or starts a game.
async function suite(platform, env = {}, dockerExit = '0', modsConfig = null) {
  const root = await mkdtemp(join(tmpdir(), 'run-suite-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  await mkdir(join(root, 'mods'));
  await mkdir(join(root, 'config'));
  await mkdir(join(root, 'mods', 'MyMod', 'About'), { recursive: true });
  await writeFile(join(root, 'mods', 'MyMod', 'About', 'About.xml'),
    '<ModMetaData><packageId>cryptik.mymod</packageId></ModMetaData>');
  await writeFile(join(root, 'config', 'ModsConfig.xml'), modsConfig ?? [
    '<ModsConfigData><activeMods>',
    '  <li>ludeon.rimworld</li>',
    '  <li>cryptik.mymod</li>',
    '</activeMods></ModsConfigData>',
  ].join('\n'));
  for (const name of ['docker', 'gamecrate']) {
    await writeFile(join(bin, name), [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$@" >> "$DOCKER_ARGV"',
      '[[ "$1" == run ]] && exit "$DOCKER_EXIT"',
      'exit 0',
    ].join('\n'), { mode: 0o755 });
  }

  const argv = join(root, 'docker-argv');
  const err = join(root, 'stderr.log');
  await writeFile(argv, '');
  await writeFile(err, '');
  // The 45s watchdog subshell outlives the script and holds every pipe it inherited, so give the
  // script files rather than pipes. timeout still passes the script's own exit code through.
  const result = await run('timeout', ['-s', 'KILL', '30', 'bash', '-c',
    'exec bash "$0" "$@" > "$LOG_DIR/stdout.log" 2> "$LOG_DIR/stderr.log"', scripts[platform],
    'example/image', join(root, 'mods'), join(root, 'config'), join(root, 'reports')], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: root,
      LOG_DIR: root,
      DOCKER_ARGV: argv,
      DOCKER_EXIT: dockerExit,
      ...env,
    },
  }).catch((e) => e);

  return {
    root,
    code: result.code ?? 0,
    stderr: await readFile(err, 'utf8'),
    argv: (await readFile(argv, 'utf8')).split('\n'),
  };
}

test('refuses a film length that is not a number, naming the variable and the value', async () => {
  const { code, stderr } = await suite('linux', { FILM_SECONDS: 'false', UNFILTERED: 'true' });
  assert.equal(code, 1);
  assert.match(stderr, /FILM_SECONDS is 'false', not a whole number/);
});

test('refuses a run timeout that is not a number, on both platforms', async () => {
  for (const platform of ['linux', 'windows']) {
    const { code, stderr } = await suite(platform, { RUN_TIMEOUT: 'abc', UNFILTERED: 'true' });
    assert.equal(code, 1, platform);
    assert.match(stderr, /RUN_TIMEOUT is 'abc', not a whole number/);
  }
});

test('passes a valid film length and run timeout through untouched', async () => {
  const { code, argv } = await suite('linux', { FILM_SECONDS: '0', RUN_TIMEOUT: '30', UNFILTERED: 'true' });
  assert.equal(code, 0);
  assert.ok(argv.includes('-pickle-max-film-seconds=0'));
  assert.ok(argv.includes('-pickle-run-timeout=30'));
  assert.ok(!argv.some((arg) => arg.includes('ffmpeg')));
});

test('hands the container exit code back to the verdict step unchanged', async () => {
  for (const platform of ['linux', 'windows']) {
    for (const want of ['75', '3']) {
      const { code } = await suite(platform, { UNFILTERED: 'true' }, want);
      assert.equal(code, Number(want), `${platform} ${want}`);
    }
  }
});

test('keeps the spaces in a filter, so a set name reaches the game as one argument', async () => {
  for (const platform of ['linux', 'windows']) {
    const { argv } = await suite(platform, { SUITE_FILTER: 'Cosmere - Core' });
    assert.ok(argv.includes('-pickle-run=Cosmere - Core'), platform);
  }
});

test('hands gamecrate one mod ref per staged folder, skipping the official DLC', async () => {
  const { argv } = await suite('linux', { UNFILTERED: 'true' });

  const refs = argv.filter((arg) => arg.startsWith('path:'));
  assert.equal(refs.length, 1);
  assert.ok(refs[0].endsWith('/mods/MyMod'));
  assert.ok(!argv.some((arg) => arg.includes('ludeon.rimworld')));
});

test('keeps the ModsConfig load order, so the mod under test still loads last', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-suite-order-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  await mkdir(join(root, 'config'));
  for (const [folder, id] of [['Dep', 'other.dep'], ['Mine', 'cryptik.mymod']]) {
    await mkdir(join(root, 'mods', folder, 'About'), { recursive: true });
    await writeFile(join(root, 'mods', folder, 'About', 'About.xml'),
      `<ModMetaData><packageId>${id}</packageId></ModMetaData>`);
  }
  await writeFile(join(root, 'config', 'ModsConfig.xml'), [
    '<ModsConfigData><activeMods>',
    '  <li>other.dep</li>',
    '  <li>cryptik.mymod</li>',
    '</activeMods></ModsConfigData>',
  ].join('\n'));
  await writeFile(join(bin, 'gamecrate'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$@" >> "$DOCKER_ARGV"',
    'exit 0',
  ].join('\n'), { mode: 0o755 });

  const argvFile = join(root, 'argv');
  await writeFile(argvFile, '');
  await run('timeout', ['-s', 'KILL', '30', 'bash', '-c',
    'exec bash "$0" "$@" > /dev/null 2>&1', scripts.linux,
    'example/image', join(root, 'mods'), join(root, 'config'), join(root, 'reports')], {
    env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: root, DOCKER_ARGV: argvFile, UNFILTERED: 'true' },
  }).catch((e) => e);

  const refs = (await readFile(argvFile, 'utf8')).split('\n').filter((a) => a.startsWith('path:'));
  assert.deepEqual(refs.map((r) => r.split('/').pop()), ['Dep', 'Mine']);
});

test('matches a mod by its own packageId, not by one it declares a dependency on', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-suite-dep-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  await mkdir(join(root, 'config'));
  await mkdir(join(root, 'mods', 'Dep', 'About'), { recursive: true });
  await writeFile(join(root, 'mods', 'Dep', 'About', 'About.xml'),
    '<ModMetaData><packageId>RimWorks.RimLogging</packageId></ModMetaData>');
  await mkdir(join(root, 'mods', 'App', 'About'), { recursive: true });
  await writeFile(join(root, 'mods', 'App', 'About', 'About.xml'), [
    '<ModMetaData><packageId>rimworks.pickle</packageId>',
    '<modDependencies><li><packageId>RimWorks.RimLogging</packageId></li></modDependencies>',
    '</ModMetaData>',
  ].join('\n'));
  await writeFile(join(root, 'config', 'ModsConfig.xml'), [
    '<ModsConfigData><activeMods>',
    '  <li>rimworks.rimlogging</li>',
    '  <li>rimworks.pickle</li>',
    '</activeMods></ModsConfigData>',
  ].join('\n'));
  await writeFile(join(bin, 'gamecrate'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$@" >> "$DOCKER_ARGV"',
    'exit 0',
  ].join('\n'), { mode: 0o755 });

  const argvFile = join(root, 'argv');
  await writeFile(argvFile, '');
  await run('timeout', ['-s', 'KILL', '30', 'bash', '-c',
    'exec bash "$0" "$@" > /dev/null 2>&1', scripts.linux,
    'example/image', join(root, 'mods'), join(root, 'config'), join(root, 'reports')], {
    env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: root, DOCKER_ARGV: argvFile, UNFILTERED: 'true' },
  }).catch((e) => e);

  const refs = (await readFile(argvFile, 'utf8')).split('\n').filter((a) => a.startsWith('path:'));
  assert.deepEqual(refs.map((r) => r.split('/').pop()), ['Dep', 'App']);
});

test('turns the update check off, since it wants a steam account no runner has', async () => {
  const { root } = await suite('linux', { UNFILTERED: 'true' });

  const written = await readFile(join(root, 'gamecrate-config', 'gamecrate', 'config.yml'), 'utf8');

  assert.match(written, /check: false/);
  assert.match(written, /cpus: \d+/);
});

test('passes --ci, so a committed .gamecrate.yml cannot swap the mod set', async () => {
  const { argv } = await suite('linux', { UNFILTERED: 'true' });

  assert.equal(argv[0], 'run');
  assert.equal(argv[1], '--ci');
  assert.ok(argv.includes('--game'), 'a bare --ci cannot infer the game with no ci profile');
});

test('splits every docker-arg into its own flag, which is the only form docker accepts', async () => {
  const { argv } = await suite('linux', { UNFILTERED: 'true' });

  const mount = argv.findIndex((arg) => arg.endsWith('/reports:/out'));
  assert.ok(mount > 1);
  assert.equal(argv[mount - 1], '--docker-arg');
  assert.equal(argv[mount - 2], '-v');
});

test('refuses a ModsConfig id that no staged folder declares', async () => {
  const { code, stderr } = await suite('linux', { UNFILTERED: 'true' }, '0', [
    '<ModsConfigData><activeMods>',
    '  <li>nobody.ghost</li>',
    '</activeMods></ModsConfigData>',
  ].join('\n'));

  assert.equal(code, 1);
  assert.match(stderr, /lists 'nobody\.ghost' and no folder/);
});

test('mounts the config directory where the game looks for it on windows', async () => {
  const { argv } = await suite('windows', { UNFILTERED: 'true' });
  assert.ok(argv.some((arg) => arg.endsWith('/config:/home/app/savedata/Config')));
  assert.ok(argv.includes('-savedatafolder=Z:\\home\\app\\savedata'));
});

// A retry reuses one container.log path, so an attempt that exits before docker runs has to leave
// an empty one or the verdict greps the last attempt's X death and retries for the wrong reason.
for (const platform of ['linux', 'windows']) {
  test(`${platform}: an early exit still clears the last attempt's container log`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'run-suite-stale-'));
    await mkdir(join(root, 'mods'));
    await mkdir(join(root, 'config'));
    await writeFile(join(root, 'container.log'), 'XIO:  fatal IO error 11\n');

    // a non-numeric film length exits before docker is reached
    await run('bash', [scripts[platform], 'example/image', join(root, 'mods'), join(root, 'config'),
      join(root, 'reports')], {
      env: { PATH: process.env.PATH, RUNNER_TEMP: root, UNFILTERED: 'true', FILM_SECONDS: 'false' },
    }).catch((e) => e);

    assert.equal(await readFile(join(root, 'container.log'), 'utf8'), '');
  });
}
