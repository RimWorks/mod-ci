#!/usr/bin/env node
import { resolve } from 'node:path';

import { publishSteam } from '../lib/publish-steam.mjs';

const [configArg = 'release.config.mjs'] = process.argv.slice(2);
const version = process.env.RELEASE_VERSION;
const branch = process.env.RELEASE_BRANCH ?? process.env.GITHUB_REF_NAME;

if (!version || !branch) {
  process.stderr.write(
    'usage: publish-steam [configPath], with RELEASE_VERSION and RELEASE_BRANCH set\n',
  );
  process.exit(2);
}

const names = await publishSteam({
  configPath: resolve(configArg),
  version,
  branch,
  notes: process.env.RELEASE_NOTES ?? '',
  dryRun: process.env.RELEASE_DRY_RUN === '1',
  stageDir: process.env.RELEASE_STAGE_DIR || undefined,
});

process.stdout.write(`pushed ${names.join(', ') || 'nothing'} at ${version}\n`);
