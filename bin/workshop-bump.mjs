#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { declaredVersions } from '../lib/ship-list.mjs';
import { declaredWorkshopIds } from '../lib/publish-steam.mjs';
import { refsDirFor } from '../lib/release-config.mjs';
import { bumpWorkshop } from '../lib/workshop-bump.mjs';

const CONFIG = 'release.config.mjs';

const [solution, explicitId = process.env.WORKSHOP_ID] = process.argv.slice(2);
if (!solution) {
  process.stderr.write('usage: workshop-bump <solution> [workshopId]\n');
  process.exit(2);
}

let workshopId = explicitId;
if (!workshopId) {
  const declared = await declaredWorkshopIds({ configPath: resolve(CONFIG) });
  if (declared.length !== 1) {
    process.stderr.write(
      `${CONFIG} declares ${declared.length} workshop ids, so name the one to push: ` +
        'workshop-bump <solution> <workshopId>, or set WORKSHOP_ID\n',
    );
    process.exit(2);
  }
  [workshopId] = declared;
}

const newest = declaredVersions(await readFile('loadFolders.xml', 'utf8')).at(-1);
if (!newest) {
  process.stderr.write('no <vX.Y> block in loadFolders.xml, so no version to stamp\n');
  process.exit(1);
}

const stagePath = await bumpWorkshop({ workshopId, solution, refsDir: refsDirFor(newest) });
process.stdout.write(`pushed from ${stagePath}\n`);
