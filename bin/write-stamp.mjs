#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

import { declaredVersions } from '../lib/ship-list.mjs';
import { stagedRefsDir } from '../lib/release-config.mjs';
import { writeStamp } from '../lib/write-stamp.mjs';

const solution = process.argv[2];
if (!solution) {
  process.stderr.write('usage: write-stamp <solution>\n');
  process.exit(2);
}

const newest = declaredVersions(await readFile('loadFolders.xml', 'utf8')).at(-1);
if (!newest) {
  process.stderr.write('no <vX.Y> block in loadFolders.xml, so no version to stamp\n');
  process.exit(1);
}

// no staged refs means the build used the Krafs package, which the package list already names
process.stdout.write(await writeStamp({ solution, refsDir: stagedRefsDir(newest) }));
