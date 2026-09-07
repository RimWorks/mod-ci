import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// RimWorld loads these from the mod root by convention. Assemblies and the per-backend
// folders are build output, so they are absent from the repo and cannot be checked this way.
export const MOD_CONTENT_DIRECTORIES = [
  'About',
  'Defs',
  'Languages',
  'Textures',
  'Sounds',
  'Patches',
];

/** The paths a `cp -r ... dist/<Mod>/` step copies into the release zip. */
export function shippedPaths(releaseConfig) {
  const cp = /cp -r (?<paths>.+?) dist\//.exec(releaseConfig);
  if (!cp) return null;
  return cp.groups.paths.split(/\s+/).filter(Boolean);
}

/**
 * Mod content directories that exist in the repo but the release zip never copies.
 * Steam rsyncs by exclusion so it ships them anyway, which is how this stays invisible.
 */
export async function missingFromReleaseZip(repoRoot = process.cwd()) {
  const configPath = join(repoRoot, 'release.config.mjs');
  if (!existsSync(configPath)) throw new Error(`no release.config.mjs under ${repoRoot}`);

  const shipped = shippedPaths(await readFile(configPath, 'utf8'));
  if (shipped === null) return { shipped: null, missing: [] };

  const missing = MOD_CONTENT_DIRECTORIES.filter(
    (dir) => existsSync(join(repoRoot, dir)) && !shipped.includes(dir),
  );
  return { shipped, missing };
}
