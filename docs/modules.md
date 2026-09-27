# Modules

Functions `@rimworks/mod-ci` exports. A release config and the CLI wrappers call these.

## `writeStamp`

Records what a verification run tested against. Pass the solution so the stamp can list resolved
package versions.

```js
import { writeStamp } from '@rimworks/mod-ci';

await writeStamp({ solution: 'RimWorks.RimLogging.sln' });
```

The stamp reads `VERIFIED_COMMIT` and `VERIFIED_TESTS` from the environment when they are set.
Omit `solution` and the stamp still writes, but without the package table. Pass `refsDir`, the
staged `Managed` directory, and the table leads with the game build read out of its `Version.txt`.

## `packageMod`

```js
import { packageMod } from '@rimworks/mod-ci';

const { zipPath, entries } = await packageMod({ name: 'Pickle', version: '1.2.3' });
```

Returns the zip path and the top-level names that went in. Takes `modPath` for a repo that holds
several mods, and `outDir` when `dist` is taken.

## `releaseConfig`

The whole semantic-release config for a mod repo. A repo declares what it contains. The function
decides how the release runs.

```js
import { readFileSync } from 'node:fs';

import { declaredVersions, releaseConfig } from '@rimworks/mod-ci';

export default releaseConfig({
  solution: 'Quickstarts.slnx',
  versions: declaredVersions(readFileSync('loadFolders.xml', 'utf8')),
  mods: [{ name: 'Quickstarts', workshopId: '3793646067' }],
  pack: 'Source/Quickstarts.Ref/Quickstarts.Ref.csproj',
  nupkgGlob: 'artifacts/RimWorks.Quickstarts.Ref.${nextRelease.version}.nupkg',
});
```

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `solution` | string | required | Solution or project the release builds. |
| `versions` | string[] | required | Game versions to build. Read them from `loadFolders.xml` with `declaredVersions`. |
| `mods` | object[] | required | One entry per mod in the repo. Each takes `name`, `workshopId`, and an optional `previewfile`. |
| `branches` | array | `['main']` | Passed to semantic-release. |
| `extraRules` | object[] | `[]` | Extra `releaseRules`, added before the shared set. |
| `beforeBuild` | string[] | `[]` | Commands to run before the first build, such as a frontend bundle. |
| `pack` | string | none | Project to pack as a NuGet package. Without it the release packs nothing. |
| `packArgs` | string | `''` | Extra MSBuild arguments for the pack step. |
| `packOut` | string | `artifacts` | Output directory for the package. |
| `nupkgGlob` | string | none | Package to push. Without it the release publishes nothing to NuGet. |
| `assets` | object[] | `[]` | Files to attach to the GitHub release. |

An empty `workshopId` drops the Steam plugin, so a mod without a Workshop item still releases.

The commit analyzer gets a `breakingHeaderPattern`. The angular preset ignores the `!` marker,
so `fix!: drop a thing` reads as a plain patch without it. With it, `!` cuts a major.

## Order of the prepare step

The function fixes this order, because each step depends on the one before it:

1. `beforeBuild`
2. One `dotnet build` per version, each against that version's own assemblies.
3. `verify-ship-list`, which compares `loadFolders.xml` to the folders that were built.
4. `write-stamp`, which reads resolved package versions and so needs a restore first.
5. `dotnet pack`, when `pack` is set.
6. `package-mod`, once per mod.

## Overriding the result

The return value is a plain object. Spread it and override the part you need:

```js
const config = releaseConfig({ ...ordinary });

export default { ...config, branches: ['next'] };
```

Prefer that over a new option. An option that one repo uses costs every reader of this file.

## `bumpWorkshop`

Pushes the mod to Steam with a fresh stamp. Weekly verification runs call it.

```js
import { bumpWorkshop } from '@rimworks/mod-ci';

await bumpWorkshop({
  workshopId: '3733484696',
  solution: 'RimWorks.RimLogging.sln',
  refsDir: process.env.GameManagedDir,
});
```

Pass `refsDir` to get the RimWorld line in the stamp. Without it the stamp lists the packages and
says nothing about which game build was verified.

It needs `STEAMCMD_PATH`, `STEAM_USERNAME` and `STEAM_CONFIG_VDF`. It does not set the title, preview
image or visibility. The Workshop page keeps what it already has.

Builds are deterministic. An unchanged source tree rebuilds to the same bytes, and Steam moves the
"Updated" date only when the content manifest changes. The stamp is what makes the date move.
