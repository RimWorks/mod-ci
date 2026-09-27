#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

import { declaredVersions } from '../lib/ship-list.mjs';
import { refsDirFor } from '../lib/release-config.mjs';
import { writeStamp } from '../lib/write-stamp.mjs';

const solution = process.argv[2];
if (!solution) {
  process.stderr.write('usage: write-stamp <solution>\n');
  process.exit(2);
}

// one stamp, so it quotes the newest version the mod claims
const newest = declaredVersions(await readFile('loadFolders.xml', 'utf8')).at(-1);
if (!newest) {
  process.stderr.write('no <vX.Y> block in loadFolders.xml, so no version to stamp\n');
  process.exit(1);
}

process.stdout.write(await writeStamp({ solution, refsDir: refsDirFor(newest) }));
