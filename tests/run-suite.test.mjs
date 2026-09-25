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
async function suite(platform, env = {}, dockerExit = '0') {
  const root = await mkdtemp(join(tmpdir(), 'run-suite-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  await mkdir(join(root, 'mods'));
  await mkdir(join(root, 'config'));
  await writeFile(join(bin, 'docker'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$@" >> "$DOCKER_ARGV"',
    '[[ "$1" == run ]] && exit "$DOCKER_EXIT"',
    'exit 0',
  ].join('\n'), { mode: 0o755 });

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
  // film off means no ffmpeg download and no mount for it
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

test('mounts the config directory where the game looks for it on windows', async () => {
  // GenFilePaths.ConfigFolderPath is savedatafolder plus Config, so a flat mount hides ModsConfig
  const { argv } = await suite('windows', { UNFILTERED: 'true' });
  assert.ok(argv.some((arg) => arg.endsWith('/config:/config/Config')));
  assert.ok(argv.includes('-savedatafolder=Z:\\config'));
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
