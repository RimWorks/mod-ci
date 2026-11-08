#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { declaredVersions } from '../lib/ship-list.mjs';
import { buildVersions } from '../lib/release-config.mjs';

const run = promisify(execFile);

const argv = process.argv.slice(2);
let root = '.';
const flag = argv.findIndex((a) => a === '--root' || a.startsWith('--root='));
if (flag !== -1) {
  const [name, next] = argv.slice(flag, flag + 2);
  if (name.includes('=')) {
    root = name.slice('--root='.length);
    argv.splice(flag, 1);
  } else {
    root = next ?? '.';
    argv.splice(flag, 2);
  }
}

const [solution, ...extra] = argv;
if (!solution) {
  process.stderr.write('usage: build-mod [--root <dir>] <solution> [extra msbuild args]\n');
  process.exit(2);
}

const versions = declaredVersions(await readFile(join(root, 'loadFolders.xml'), 'utf8'));

for (const cmd of buildVersions({ solution, versions, args: extra.join(' ') })) {
  process.stdout.write(`${cmd}\n`);
  const [bin, ...args] = cmd.split(' ').filter(Boolean);
  const { stdout } = await run(bin, args, { cwd: root });
  process.stdout.write(stdout.split('\n').slice(-4).join('\n'));
}
