#!/usr/bin/env node
import { packageMod } from '../lib/package-mod.mjs';

const [name, version] = process.argv.slice(2);
if (!name || !version) {
  console.error('usage: package-mod <name> <version>');
  process.exit(2);
}

try {
  const { zipPath, entries } = await packageMod({ name, version });
  console.log(`package-mod: ${zipPath} ships ${entries.join(' ')}`);
} catch (err) {
  console.error(`package-mod: ${err.message}`);
  process.exit(1);
}
