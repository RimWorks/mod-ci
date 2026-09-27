#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { declaredVersions } from '../lib/ship-list.mjs';
import { buildVersions } from '../lib/release-config.mjs';

const run = promisify(execFile);

const [solution, ...extra] = process.argv.slice(2);
if (!solution) {
  process.stderr.write('usage: build-mod <solution> [extra msbuild args]\n');
  process.exit(2);
}

const versions = declaredVersions(await readFile('loadFolders.xml', 'utf8'));

// the same command release.config.mjs assembles, without semantic-release's version templates
for (const cmd of buildVersions({ solution, versions, args: extra.join(' ') })) {
  process.stdout.write(`${cmd}\n`);
  const [bin, ...args] = cmd.split(' ').filter(Boolean);
  const { stdout } = await run(bin, args);
  process.stdout.write(stdout.split('\n').slice(-4).join('\n'));
}
