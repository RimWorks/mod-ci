#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { packageMod } from '../lib/package-mod.mjs';

const {
  values: { root },
  positionals: [name, version],
} = parseArgs({
  options: { root: { type: 'string', default: '.' } },
  allowPositionals: true,
});

if (!name || !version) {
  console.error('usage: package-mod [--root <dir>] <name> <version>');
  process.exit(2);
}

try {
  const { zipPath, entries } = await packageMod({ name, version, modPath: root });
  console.log(`package-mod: ${zipPath} ships ${entries.join(' ')}`);
} catch (err) {
  console.error(`package-mod: ${err.message}`);
  process.exit(1);
}
