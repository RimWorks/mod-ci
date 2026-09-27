#!/usr/bin/env node
import { versionFolderMismatch } from '../lib/ship-list.mjs';

const root = process.argv[2] ?? process.cwd();

let result;
try {
  result = await versionFolderMismatch(root);
} catch (err) {
  console.error(`verify-ship-list: ${err.message}`);
  process.exit(2);
}

const { declared, missing, undeclared } = result;

if (missing.length > 0) {
  console.error(`loadFolders.xml claims ${missing.join(', ')} but no such folder was built`);
  console.error('RimWorld falls back to the root for those, so the mod loads no assemblies.');
}

if (undeclared.length > 0) {
  console.error(`${undeclared.join(', ')} is on disk but no <v> block in loadFolders.xml claims it`);
  console.error('Nothing loads it, so it is dead weight in the zip and on Steam.');
}

if (missing.length > 0 || undeclared.length > 0) process.exit(1);

console.log(`loadFolders.xml and the built folders agree (${declared.join(' ')})`);
