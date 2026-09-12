import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

// no Assemblies or per-backend folders: build output, absent from the repo
export const MOD_CONTENT_DIRECTORIES = [
  'About',
  'Defs',
  'Languages',
  'Textures',
  'Sounds',
  'Patches',
];

// two shapes: copy into dist/ then zip, or zip directly. reading one passed three repos
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

/** every read below goes through this, so a name cannot escape root */
function under(root, name) {
  const path = resolve(root, name);
  if (path !== root && !path.startsWith(root + sep)) {
    throw new Error(`${name} escapes ${root}`);
  }
  return path;
}

/**
 * Directories in the repo that the release zip never copies. Steam rsyncs by exclusion and
 * ships them anyway, which is what keeps this invisible. repoRoot is the operator's own arg.
 */
export async function missingFromReleaseZip(repoRoot = process.cwd()) {
  const root = resolve(repoRoot);
  const configPath = under(root, 'release.config.mjs');
  if (!existsSync(configPath)) throw new Error(`no release.config.mjs under ${root}`);

  const shipped = shippedPaths(await readFile(configPath, 'utf8'));
  if (shipped === null) return { shipped: null, missing: [] };

  const missing = MOD_CONTENT_DIRECTORIES.filter(
    (dir) => existsSync(under(root, dir)) && !shipped.includes(dir),
  );
  return { shipped, missing };
}
