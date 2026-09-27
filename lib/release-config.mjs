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

/** The env var stage-game-refs writes for a version, read out of the image's own Version.txt. */
export function stagedEnvName(version) {
  return `GAME_MANAGED_${version.replace(/\./g, '_')}`;
}

/** Where a version's assemblies are. GameManagedDir is a single-version leg only. */
export function refsDirFor(version) {
  const staged = process.env[stagedEnvName(version)] ?? process.env.GameManagedDir;
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

  // sharing one GameManagedDir across versions compiles 1.5 against 1.6 and still exits 0
  const unnamed = versions.filter((v) => !process.env[stagedEnvName(v)]);
  if (versions.length > 1 && process.env.GameManagedDir && unnamed.length > 0) {
    throw new Error(
      `buildVersions: GameManagedDir is set but ${unnamed.join(', ')} has no ` +
        `${unnamed.map(stagedEnvName).join(' or ')}. Stage each version with stage-game-refs.`,
    );
  }

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

/**
 * The whole semantic-release config for a mod repo. Returns a plain object, so a repo with a
 * need this does not cover spreads it and overrides rather than growing an option here.
 */
export function releaseConfig({
  solution,
  versions,
  mods = [],
  branches = ['main'],
  extraRules = [],
  beforeBuild = [],
  pack,
  packArgs = '',
  packOut = 'artifacts',
  assets = [],
  nupkgGlob,
}) {
  if (!solution) throw new Error('releaseConfig: solution is required');
  if (!versions?.length) throw new Error('releaseConfig: versions is required');
  if (mods.length === 0) throw new Error('releaseConfig: at least one mod is required');

  // builds first: the stamp reads resolved package versions, which needs a restore
  const prepare = [
    ...beforeBuild,
    ...buildVersions({ solution, versions }),
    'npx verify-ship-list .',
    `npx write-stamp ${solution}`,
    ...(pack ? [`dotnet pack ${pack} -c Release ${VERSION_ARGS} ${packArgs} -o ${packOut}`.replace(/ +/g, ' ')] : []),
    ...mods.map((m) => `npx package-mod ${m.name} \${nextRelease.version}`),
  ];

  return {
    branches,
    plugins: [
      ['@semantic-release/commit-analyzer', { releaseRules: [...extraRules, ...MOD_RELEASE_RULES] }],
      '@semantic-release/release-notes-generator',
      [
        '@semantic-release/exec',
        {
          prepareCmd: prepare.join(' && '),
          ...(nupkgGlob ? { publishCmd: nugetPush(nupkgGlob) } : {}),
        },
      ],
      ...mods.flatMap((m) => steamMod(m)),
      ...(assets.length > 0 ? [['@semantic-release/github', { assets }]] : []),
    ],
  };
}
