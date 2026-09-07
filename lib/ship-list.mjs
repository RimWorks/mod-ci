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

// two shapes across the repos: RimLogging copies into dist/ then zips it, the others zip the
// paths directly. Reading only the first form silently passed the three that use the second.
const COPY_STEP = /cp -r (?<paths>.+?) dist\//;
const ZIP_STEP = /zip -q?r [^\s]*\.zip (?<paths>.+?)(?: -x |['"]|$)/;

/** The paths the release step puts in the zip, or null when there is no zip step. */
export function shippedPaths(releaseConfig) {
  const hit = COPY_STEP.exec(releaseConfig) ?? ZIP_STEP.exec(releaseConfig);
  if (!hit) return null;

  return hit.groups.paths
    .split(/\s+/)
    .filter(Boolean)
    .filter((p) => !p.startsWith('-') && !p.startsWith('$') && p !== '.');
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
