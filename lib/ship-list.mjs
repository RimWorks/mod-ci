import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export const VERSION_DIRECTORY = /^\d+\.\d+$/;

const VERSION_BLOCK = /<v(\d+\.\d+)>/g;

export function byVersion(a, b) {
  const [aMajor, aMinor] = a.split('.').map(Number);
  const [bMajor, bMinor] = b.split('.').map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

/** The versions loadFolders.xml claims this mod supports, oldest first. */
export function declaredVersions(loadFolders) {
  return [...new Set([...loadFolders.matchAll(VERSION_BLOCK)].map((m) => m[1]))].sort(byVersion);
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
 */
export async function versionFolderMismatch(repoRoot = process.cwd()) {
  const root = resolve(repoRoot);
  const configPath = under(root, 'loadFolders.xml');
  if (!existsSync(configPath)) throw new Error(`no loadFolders.xml under ${root}`);

  const declared = declaredVersions(await readFile(configPath, 'utf8'));
  if (declared.length === 0) throw new Error(`no <vX.Y> block in ${configPath}`);

  const onDisk = (await readdir(root, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && VERSION_DIRECTORY.test(e.name))
    .map((e) => e.name)
    .sort(byVersion);

  return {
    declared,
    onDisk,
    missing: declared.filter((v) => !onDisk.includes(v)),
    undeclared: onDisk.filter((v) => !declared.includes(v)),
  };
}
