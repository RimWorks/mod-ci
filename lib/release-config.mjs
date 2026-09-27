import { homedir } from 'node:os';
import { join } from 'node:path';

/** Types that are shipped content for a mod, so a commit of one cuts a release. */
export const MOD_RELEASE_RULES = [
  { type: 'refactor', release: 'patch' },
  { type: 'style', release: 'patch' },
  { type: 'ci', release: 'patch' },
  // README.template.md is the workshop description, so docs are shipped content.
  { type: 'docs', release: 'patch' },
];

// semantic-release resolves these before the shell sees them, so the quotes never reach it
export const VERSION_ARGS = [
  '-p:Version=${nextRelease.version}',
  '-p:PackageVersion=${nextRelease.version}',
  "-p:FileVersion=${nextRelease.version.replace(/-.*/, '')}.0",
  "-p:AssemblyVersion=${nextRelease.version.replace(/-.*/, '')}.0",
  '-p:InformationalVersion=${nextRelease.version}',
].join(' ');

/**
 * Where a version's assemblies are. stage-game-refs exports GAME_MANAGED_1_6 per version and
 * GameManagedDir on a single-version leg; a dev box has gamecrate's cache instead.
 */
export function refsDirFor(version) {
  const staged = process.env[`GAME_MANAGED_${version.replace(/\./g, '_')}`] ?? process.env.GameManagedDir;
  if (staged) return staged;

  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cache, 'gamecrate', 'refs', 'version', 'rimworld', version);
}

/** One `dotnet build` per version, so the zip cannot advertise a version it did not build. */
export function buildVersions({ solution, versions, args = VERSION_ARGS }) {
  for (const [key, value] of Object.entries({ solution, versions })) {
    if (!value) throw new Error(`buildVersions: ${key} is required`);
  }
  if (versions.length === 0) throw new Error('buildVersions: no versions to build');

  return versions.map(
    (v) =>
      `dotnet build ${solution} -c Release ${args} -p:GameVersion=${v}` +
      ` -p:GameManagedDir=${refsDirFor(v)}`,
  );
}

/** The steam plugin tuple. title and tags stay unset so the Workshop page keeps what it has. */
export function steamMod({ name, workshopId, previewfile, appId = '294100' }) {
  if (!name) throw new Error('steamMod: name is required');
  if (!workshopId) return [];

  const mod = { name, path: '.', workshopIds: { stable: workshopId } };
  if (previewfile) mod.previewfile = previewfile;

  return [['semantic-release-steam', { appId, branchTargets: { main: 'stable' }, mods: [mod] }]];
}

/** Trusted publishing supplies the key in CI. Absent means a local dry run, so skip the push. */
export function nugetPush(nupkgGlob) {
  if (!nupkgGlob) throw new Error('nugetPush: a nupkg glob is required');

  return (
    `if [ -n "$NUGET_API_KEY" ]; then dotnet nuget push "${nupkgGlob}"` +
    ' --api-key "$NUGET_API_KEY" --source https://api.nuget.org/v3/index.json --skip-duplicate;' +
    ' else echo "no NUGET_API_KEY, skipping nuget push"; fi'
  );
}
