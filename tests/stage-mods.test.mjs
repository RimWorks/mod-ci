import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = join(import.meta.dirname, '..', '.github', 'actions', 'stage-mods', 'stage-mods.sh');

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

// A curl that answers the release api and an unzip that unpacks its answer, so a whole staging
// run happens offline. The zip a download writes is just the folder name the unzip stub creates.
const curlStub = `#!/bin/sh
out=""; url=""; prev=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  case "$a" in https://*) url="$a";; esac
  prev="$a"
done
case "$url" in
  *api.github.com*)
    echo '{"assets":[{"name":"Concord-1.zip","browser_download_url":"https://stub/Concord"},{"name":"HarmonyMod-1.zip","browser_download_url":"https://stub/Harmony"},{"name":"RimLogging-1.zip","browser_download_url":"https://stub/RimLogging"},{"name":"Pickle-1.zip","browser_download_url":"https://stub/Pickle"},{"name":"Quickstarts-1.zip","browser_download_url":"https://stub/Quickstarts"}]}'
    exit 0;;
esac
printf '%s' "\${url##*/}" > "$out"
`;

const unzipStub = `#!/bin/sh
case "$1" in
  -Z1) echo "About/About.xml"; exit 0;;
  -Z) echo "-rw-r--r--  About/About.xml"; exit 0;;
esac
dir="$4"
mkdir -p "$dir/$(cat "$2")/About"
echo '<ModMetaData />' > "$dir/$(cat "$2")/About/About.xml"
`;

async function stageFully(env, backends = 'harmony') {
  const root = await mkdtemp(join(tmpdir(), 'stage-mods-'));
  await mkdir(join(root, 'mod'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'curl'), curlStub, { mode: 0o755 });
  await writeFile(join(bin, 'unzip'), unzipStub, { mode: 0o755 });

  await run('bash', [script, backends, join(root, 'mods'), join(root, 'config')], {
    cwd: root,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      MOD_DIRS: 'mod:Mod',
      MOD_PACKAGE_ID: 'rimworks.example',
      ...env,
    },
  });
  return root;
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

test('refuses a mount Pickle would be staged over, naming the mount and the dependency', async () => {
  const stderr = await stage({ MOD_DIRS: 'mod:Pickle' });
  assert.match(stderr, /mod dir 'mod:Pickle' mounts as 'Pickle'/);
  assert.match(stderr, /Pickle \(PICKLE_VERSION 'latest'\) is staged into that folder/);
});

test('refuses a mount the patch backend would be staged over', async () => {
  const stderr = await stage({ MOD_DIRS: 'mod:Harmony' });
  assert.match(stderr, /the Harmony patch backend is staged into that folder/);
});

test('a self pickle-version leaves the Pickle mount free for the checkout', async () => {
  const root = await stageFully({ MOD_DIRS: 'mod:Pickle', PICKLE_VERSION: 'self' });
  assert.ok(existsSync(join(root, 'mods', 'Pickle')));
});

test('pickle-version self writes the pickle line from the caller package ids', async () => {
  const root = await stageFully({ PICKLE_VERSION: 'self', MOD_PACKAGE_ID: 'rimworks.pickle' });
  const config = await readFile(join(root, 'config', 'ModsConfig.xml'), 'utf8');

  assert.equal(config.match(/<li>rimworks\.pickle<\/li>/g).length, 1);
  assert.ok(!existsSync(join(root, 'mods', 'Pickle')));
});

test('pickle-version none stages no Pickle and lists no pickle line', async () => {
  const root = await stageFully({ PICKLE_VERSION: 'none', MOD_PACKAGE_ID: 'rimworks.quickstarts' });
  const config = await readFile(join(root, 'config', 'ModsConfig.xml'), 'utf8');

  assert.ok(!existsSync(join(root, 'mods', 'Pickle')));
  assert.doesNotMatch(config, /rimworks\.pickle/);
  assert.match(config, /<li>rimworks\.quickstarts<\/li>\n {2}<\/activeMods>/);
});

test('a floating pickle-version stages Pickle and lists it before the caller', async () => {
  const root = await stageFully({});
  const config = await readFile(join(root, 'config', 'ModsConfig.xml'), 'utf8');

  assert.ok(existsSync(join(root, 'mods', 'Pickle', 'About', 'About.xml')));
  assert.ok(config.indexOf('rimworks.pickle') < config.indexOf('rimworks.example'));
});
