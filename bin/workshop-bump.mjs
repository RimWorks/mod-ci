#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

import { declaredVersions } from '../lib/ship-list.mjs';
import { refsDirFor } from '../lib/release-config.mjs';
import { bumpWorkshop } from '../lib/workshop-bump.mjs';

const [solution, workshopId = process.env.WORKSHOP_ID] = process.argv.slice(2);
if (!solution || !workshopId) {
  process.stderr.write('usage: workshop-bump <solution> [workshopId], or set WORKSHOP_ID\n');
  process.exit(2);
}

// refsDir is not optional in practice: without it the stamp names no game version
const newest = declaredVersions(await readFile('loadFolders.xml', 'utf8')).at(-1);
if (!newest) {
  process.stderr.write('no <vX.Y> block in loadFolders.xml, so no version to stamp\n');
  process.exit(1);
}

const stagePath = await bumpWorkshop({ workshopId, solution, refsDir: refsDirFor(newest) });
process.stdout.write(`pushed from ${stagePath}\n`);
