# @rimworks/mod-ci

Shared release plumbing for the RimWorks RimWorld mods. Four repos ran near-identical copies of
these scripts. The copies drifted, so a fix landed in one and went stale in the other three.

Used by [RimLogging][rl], [Pickle][pk], [Quickstarts][qs] and [RimObs][ro].

## Install

```bash
npm install --save-dev github:RimWorks/mod-ci#v1.0.0
```

It is not on npm. Consumers install from the git tag, so the release never has to push a version
commit back to a protected branch.

`bumpWorkshop` also needs `semantic-release-steam`. It is an optional peer dependency, so install
it only in repos that publish to the Steam Workshop.

## What it does

| Export | Purpose |
|---|---|
| `writeStamp` | Writes `About/PublishStamp.txt` with the versions the mod was built against |
| `bumpWorkshop` | Stages the mod and pushes it to its Workshop item |
| `missingFromReleaseZip` | Finds mod folders the GitHub release zip drops |
| `verify-ship-list` | CLI wrapper around `missingFromReleaseZip` |

### writeStamp

Records what a verification run tested against. Pass the solution so the stamp can list resolved
package versions.

```js
import { writeStamp } from '@rimworks/mod-ci';

await writeStamp({ solution: 'RimWorks.RimLogging.sln' });
```

The stamp reads `VERIFIED_COMMIT` and `VERIFIED_TESTS` from the environment when they are set.
Omit `solution` and the stamp still writes, but without the package table.

The old per-repo copies took no `solution` argument. They read a hardcoded default instead, and
changing that default was the only difference between the four files.

### bumpWorkshop

Pushes the mod to Steam with a fresh stamp. Weekly verification runs call it.

```js
import { bumpWorkshop } from '@rimworks/mod-ci';

await bumpWorkshop({ workshopId: '3733484696', solution: 'RimWorks.RimLogging.sln' });
```

Requires `STEAMCMD_PATH`, `STEAM_USERNAME` and `STEAM_CONFIG_VDF`. It sets no title, preview image
or visibility, so the Workshop page keeps what it already has.

Builds are deterministic. An unchanged source tree rebuilds byte for byte, and Steam moves the
"Updated" date only when the content manifest changes. The stamp is what makes the date move.

### verify-ship-list

Steam and GitHub ship different file sets:

| Channel | Mechanism | Failure mode |
|---|---|---|
| Steam | Copies the mod folder, `.steamignore` **excludes** | Ships too much |
| GitHub | `cp -r <allowlist>` in `release.config.mjs` **includes** | Ships too little, silently |

Add an asset folder and Steam picks it up. The GitHub zip drops it, and nothing reports an error.
RimLogging shipped without `Textures/` for eight releases this way. The log viewer could not load
its own button art, and the failure only appeared in a downstream repo's test run.

Run it against a repo root:

```bash
npx verify-ship-list .
```

It exits `1` and names the folders when the `cp -r` step misses one that exists in the repo. A
`release.config.mjs` with no `cp -r ... dist/` step exits `0`, because there is no zip to check.

## Reusable workflows

Call these from a consumer repo instead of copying them.

```yaml
name: dependabot-automerge
on: pull_request_target

jobs:
  automerge:
    uses: RimWorks/mod-ci/.github/workflows/dependabot-automerge.yml@v1
    secrets: inherit
```

`dependabot-automerge` merges patch and minor updates. Major updates stay open for a human,
because MSTest 3 to 4 and TypeScript 5 to 7 both broke the build.

## Development

```bash
npm test
```

Tests use the built-in Node test runner. No framework, no fixtures directory.

[rl]: https://github.com/RimWorks/rimworld-logging-framework
[pk]: https://github.com/RimWorks/Rimworld-Pickle
[qs]: https://github.com/RimWorks/Rimworld-Quickstarts
[ro]: https://github.com/RimWorks/rimworld-observability-collector
