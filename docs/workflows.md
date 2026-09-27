# Reusable workflows

Workflows a consumer calls with `uses:`. Each one lists its inputs and what a caller has to grant it.

Call these from a consumer repo instead of copying them.

**Grant the permissions the workflow declares.** A called workflow cannot hold a wider
`GITHUB_TOKEN` scope than its caller granted. GitHub compares the two before it starts any job,
so a caller that grants less fails the whole run at startup, before any job produces a log.
The check reaches through every level, so a workflow that calls a workflow that calls one of
these has to grant the scopes at each hop.

| Workflow | Permissions the calling job must grant |
| --- | --- |
| `assetbundles` | `contents: read` |
| `codeql` | `contents: read`, `security-events: write` |
| `dotnet-build` | `contents: read`, `checks: write`, `packages: read` |
| `game-image` | `contents: read`, `packages: write` |
| `links` | `contents: read` |
| `node-build` | `contents: read` |
| `pickle-suite` | `contents: read`, `packages: write`, `actions: read` |
| `package-deps` | `contents: read`, `packages: read` |
| `prose` | `contents: read` |
| `sonar` | `contents: read`, `packages: read` |
| `sonar-scan` | `contents: read` |
| `test` | `contents: read` |

## `assetbundles`

Builds Unity asset bundles for every mod directory you name, then uploads one zip per mod. The
Unity install takes about fifteen minutes. The job caches the built bundles and skips the
install on a hit.

```yaml
  assetbundles:
    uses: RimWorks/mod-ci/.github/workflows/assetbundles.yml@v1
    with:
      mods: |
        CosmereCore
        CosmereRoshar
        CosmereScadrial
    secrets:
      UNITY_EMAIL: ${{ secrets.UNITY_EMAIL }}
      UNITY_PASSWORD: ${{ secrets.UNITY_PASSWORD }}
```

`mods` is the only required input. The defaults match the AssetBundleBuilder layout:

- an `.assetbundler.toml` per repo and per mod
- a `make build-assets-all-verbose` target
- an `AssetBundles` directory inside each mod

Override `build-command`, `bundles-directory` or `cache-key-files` for a different layout.

`cache-key-files` is the input to get right. It is a comma separated list of `hashFiles`
patterns, and anything that changes a bundle has to appear in it. A pattern that misses a source
file makes the job serve stale bundles.

The output `artifact` returns the artifact name. A later job can download it without
repeating the string.

## `codeql`

Runs GitHub code scanning. The caller defines the triggers and has to grant `security-events: write`,
because a called workflow cannot widen the caller's scopes.

```yaml
name: codeql
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: '17 6 * * 1'

jobs:
  analyze:
    uses: RimWorks/mod-ci/.github/workflows/codeql.yml@v1
    permissions:
      contents: read
      security-events: write
    with:
      languages: '["csharp", "actions"]'
```

`languages` is a JSON array and defaults to `["actions"]`, which every repo here can run.

## `dependabot-automerge`

Merges patch and minor updates. Major updates wait for a human, because MSTest 3 to 4 and
TypeScript 5 to 7 both broke the build.

```yaml
name: dependabot-automerge
on: pull_request_target

jobs:
  automerge:
    uses: RimWorks/mod-ci/.github/workflows/dependabot-automerge.yml@v1
```

## `dotnet-build`

Builds, tests, publishes the results and checks formatting, once per game version. Every leg gets
its own game image, so 1.5 never compiles against 1.6 assemblies.

`game-image.yml` returns one `image-ref`, and a matrix inside a reusable workflow cannot emit a
map. So the caller calls it once per version and composes the `game-images` pairs:

```yaml
jobs:
  image-15:
    uses: RimWorks/mod-ci/.github/workflows/game-image.yml@v1
    permissions:
      contents: read
      packages: write
    with:
      branch: version-1.5
    secrets: inherit

  image-16:
    uses: RimWorks/mod-ci/.github/workflows/game-image.yml@v1
    permissions:
      contents: read
      packages: write
    with:
      branch: version-1.6.4633
    secrets: inherit

  build:
    needs: [image-15, image-16]
    uses: RimWorks/mod-ci/.github/workflows/dotnet-build.yml@v1
    permissions:
      contents: read
      checks: write
      packages: read
    with:
      solution: Pickle.slnx
      game-images: |
        1.5=${{ needs.image-15.outputs.image-ref }}
        1.6=${{ needs.image-16.outputs.image-ref }}
```

A `game-images` line that is not `<version>=<image ref>`, a repeated version, or an empty list
fails the `prepare` job before any leg starts. A skipped image job leaves the ref empty, which
reads as a malformed line and fails the same way.

`GameVersion` and the staged `Managed` directory reach msbuild through the environment as well as
`-p:`, because `dotnet format` takes no `-p:` and still resolves references.

## `game-image`

Builds a RimWorld image per version from Steam and returns a map of them. It matrixes internally,
so a caller writes one job however many versions it needs.

```yaml
images:
  uses: RimWorks/mod-ci/.github/workflows/game-image.yml@v2
  permissions:
    contents: read
    packages: write
  with:
    branches: |
      1.5=version-1.5
      1.6=version-1.6.4633
  secrets: inherit
```

| Input | Default | What it does |
| --- | --- | --- |
| `branches` | required | Newline `<game version>=<steam branch>` pairs. One image per line. |
| `app-id` | `294100` | Steam app id. |
| `image` | owner namespace | Repository to push to. |
| `include-paths` | all | Limits the image. `Managed` alone compiles, but the game cannot run. |
| `force` | `false` | Rebuilds even when the Steam buildid has not moved. |
| `windows` | `false` | Also builds Windows images, under the Linux name plus `-windows`. |

`outputs.image-refs` is a JSON object of game version to image ref. Pass it straight to
[`dotnet-build`](#dotnet-build) as `game-images`. Read one entry with
`fromJSON(needs.images.outputs.image-refs)['1.6']`.

A malformed line, a repeated version or an empty list fails the `prepare` job before any image
builds. The Windows legs return `outputs.windows-image-refs` and are allowed to fail without
failing the caller.

`include-paths` must list `Version.txt` if you set it. Without that file `stage-game-refs` fails,
and the stamp has no game build to name.

## `package-deps`

Packs a project and fails when its nuspec declares a dependency on a reference package. A consumer
that restores such a package gets every game type twice and fails with CS0433.

```yaml
package-deps:
  uses: RimWorks/mod-ci/.github/workflows/package-deps.yml@v2
  permissions:
    contents: read
    packages: read
  with:
    project: Source/Pickle.Ref/Pickle.Ref.csproj
    game-image: ${{ fromJSON(needs.images.outputs.image-refs)['1.6'] }}
    reference-packages: |
      Concord.Ref
      Microsoft.NETFramework.ReferenceAssemblies
```

`reference-packages` is required, and an empty list fails the job. A default would have let a
caller that sets nothing pass a check that asserts nothing.

An `exclude` attribute on the `PackageReference` still writes the dependency into the nuspec.
Use `PrivateAssets="all"` instead.

## `links`

Checks markdown links with lychee and fails on a dead one. Relative links break silently when a
folder is renamed.

```yaml
  links:
    uses: RimWorks/mod-ci/.github/workflows/links.yml@v1
    with:
      args: --config lychee.toml --no-progress README.md docs/
```

`args` defaults to checking `README.md`, so a repo with a `lychee.toml` does not need any inputs.

A `lychee.toml` that checks relative links and heading anchors and makes no network request. A rate
limit on Steam or GitHub would turn the run red for a reason that has nothing to do with the repo,
while a renamed folder is what breaks a relative link:

```toml
offline = true
include_fragments = "anchor-only"
no_progress = true
```

`include_fragments = true` is rejected by lychee 0.24.2; the value is the string `"anchor-only"`.

## `node-build`

Installs, optionally lints, builds, and uploads a Node subproject's output as an artifact. A mod
that embeds a bundled UI needs those files before the C# build runs, and more than one workflow in
the same repo usually needs them.

```yaml
  dashboard:
    uses: RimWorks/mod-ci/.github/workflows/node-build.yml@v1
    with:
      working-directory: Dashboard
      lint: true
      artifact-name: dashboard-dist
```

`artifact-path` defaults to `dist`, relative to `working-directory`.

## `pickle-suite`

Plays a Pickle suite against a live game. The job builds the mod and stages it alongside the mods
it depends on. It then runs the features in a container and reads pass or fail out of the report.
Pickle, Quickstarts and RimworldCosmere each kept a near-identical copy of that script set, and
the copies drifted apart. That is the failure the release plumbing here exists to stop.

```yaml
  suite:
    uses: RimWorks/mod-ci/.github/workflows/pickle-suite.yml@v1
    permissions:
      contents: read
      packages: write
      actions: read
    with:
      mod-name: RimLogging
      mod-package-id: rimworks.rimlogging
      game-branch: version-1.6.4871
    secrets:
      STEAM_USERNAME: ${{ secrets.STEAM_USERNAME }}
      STEAM_CONFIG_VDF_B64: ${{ secrets.STEAM_CONFIG_VDF_B64 }}
```

| Input | Type | Default | What it does |
|---|---|---|---|
| `mod-name` | string | required | Mod name from `About.xml`, spaces included. Names the repo-root mount and is the default filter |
| `mod-package-id` | string | required | Newline list of the caller's `packageId` values, written last in `ModsConfig.xml` |
| `mod-dirs` | string | `''` | Newline list of `checkout-path:MountName`. Empty mounts the repo root as `mod-name` |
| `game-image` | string | `''` | Image to pull and run. Empty builds one from `game-branch` |
| `game-branch` | string | `''` | Steam branch the image job downloads, such as `version-1.6.4871` |
| `game-version` | string | `'1.6'` | The `<version>` written into `ModsConfig.xml`. Not read from the image |
| `backends` | string | `'["harmony"]'` | JSON array of `harmony`, `concord` or `both`. One matrix leg per entry |
| `mod-sets` | string | `''` | JSON array of `{name, backend, extraMods}`. Replaces `backends`, and its legs report instead of gating |
| `staged-mods` | string | `''` | Comma separated `owner/repo:AssetPrefix:packageId` of extra mods to download |
| `pickle-version` | string | `''` | Pickle release to stage. Empty takes the latest, or pass a tag, `self` or `none` |
| `suite-filter` | string | `''` | Value for `-pickle-run`. Empty falls back to `mod-name`. A leg then runs its own features and nobody else's |
| `unfiltered` | boolean | `false` | Run every discovered feature with no filter. Only Pickle's own repo wants this |
| `build-command` | string | `dotnet build -c Release` | Builds the mod before staging |
| `build-artifacts` | string | `''` | Newline list of `name:path` artifacts to download before the build |
| `dotnet-version` | string | `10.0.x` | Passed to `setup-dotnet`. Empty skips it, for a build that does not use the SDK |
| `platform` | string | `'linux'` | `linux` or `windows`. Read the Windows rule below |
| `run-timeout` | number | `30` | Value for `-pickle-run-timeout`, minutes. Pickle's own watchdog |
| `timeout-minutes` | number | `70` | The job timeout, the backstop for a wedged watchdog |
| `retries` | number | `0` | Extra container attempts, for a dead X server only |
| `film-seconds` | number | `0` | Value for `-pickle-max-film-seconds`. `0` skips the ffmpeg download |
| `live-dashboard` | boolean | `false` | Exposes Pickle's dashboard over a tunnel while the suite runs |
| `publish-report` | boolean | `false` | Pushes `report.html` to docbin |

The one output, `report-artifact`, carries the artifact name back so a later job can download the
merged report without repeating the string. A matrix cannot report counts as outputs, because a
called workflow has one string slot per output name and every leg writes the same slot. The counts,
and the message from each failed scenario, go to the job summary instead.

**Secrets.** `DOCBIN_TOKEN` when `publish-report` is true. `STEAM_USERNAME` and
`STEAM_CONFIG_VDF_B64` when `game-image` is empty, because the workflow then builds the image
itself. `GITHUB_TOKEN` is not declared and does not need to be: a called workflow reads it without
a declaration.

**Permissions.** The calling job grants `contents: read`, `packages: write` and `actions: read`.
Write, not read, even when `game-image` names an image and the build is skipped: GitHub checks a
caller against every nested job before it evaluates the conditions that skip one. A job granting
less than the image job declares fails at setup, before anything runs.

A caller has to respect the rules below. The first is a limit the workflow cannot detect. Each of
the rest fails the job rather than warning, because a job skipped by an `if:` reports as skipped
and most branch protection reads a skipped required job as green.

**Call it once per workflow run.** The merge job uploads a fixed `merged-report` and downloads
every `pickle-report-*` artifact in the run, so a second call in the same workflow collides on the
first and silently folds the other call's legs into one merged report. To run one leg alongside a
matrix, a Windows job say, call the `pickle-run` action directly instead. It takes the same inputs,
reads `github.token` without being handed one, and skips the merge.

**Name the game image.** `game-image` and `game-branch` cannot both be empty. Set the first to an
image the job pulls, or the second to a Steam branch it builds one from. On Windows, `game-image`
is required: the image workflow here downloads the Linux depot and cannot produce a Windows ref.

**Windows cannot film or tunnel.** `platform: windows` refuses a non-zero `film-seconds` and
`live-dashboard: true`. That script publishes only the game's own ports, and the ffmpeg it would
mount is a Linux binary. An input it cannot honour fails the job rather than being dropped. It does
read `suite-filter`.

**Leave the job room for every attempt.** `(retries + 1) * run-timeout + 15 < timeout-minutes`,
where the 15 minutes is a fixed allowance for checkout, the build, the image pull and staging.
Raise `timeout-minutes`, or lower `run-timeout` or `retries`. When the watchdog trips first, Pickle
writes a final report and the artifact uploads. When the job timeout trips first, the container
dies mid-run and the report left on disk says `in-progress` with partial counts.

**Keep `mod-dirs` mount names clear of the staged mods.** A mount named the same as a staged
dependency's folder is replaced by that dependency, and the suite then passes against code the run
never built.

**Give every leg its own name.** A leg is named by its `backends` entry, or by the `name` of its
`mod-sets` object, and each one uploads an artifact under that name. An empty name, or two legs
sharing one, fails before the first container starts.

## `prose`

Runs Vale and reports findings on the pull request. Pass `extra-command` to run one more check
after it, such as a docs catalogue check.

```yaml
  prose:
    uses: RimWorks/mod-ci/.github/workflows/prose.yml@v1
```

A multi-version mod runs the `verify-ship-list` CLI in `prepareCmd`, after the last
`dotnet build`. There is no workflow for it: a bare checkout cannot see the version folders a
build produces, so a job that only checks out has nothing to compare.

## `sonar`

Runs the `dotnet-sonar` action as a whole job, for a mod whose build does not need extra steps. It
checks out with full history, can install Node or pnpm, and can run a `pre-scan-command` for a
frontend build that produces lcov. Use the action instead when your job has to stage
something first.

```yaml
  sonar:
    needs: image
    uses: RimWorks/mod-ci/.github/workflows/sonar.yml@v1
    with:
      solution: RimWorks.RimLogging.sln
      project-key: RimWorks_rimworld-logging-framework
      game-image: ${{ needs.image.outputs.image-ref }}
    secrets:
      SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
```

`game-image` is required. The scan runs a plain `dotnet build`, the real game assemblies are the
only reference set, and one version is enough for a scan. Call `game-image.yml` first and pass its
`image-ref`. `game-version` picks the `RW_*` constant and defaults to `1.6`.

The job skips itself for `dependabot[bot]`. A dependabot pull request does not get repository
secrets, and the scan cannot authenticate with an empty token.

**Pull requests from forks.** A `pull_request` run from a fork does not get secrets either. The
scan dies on an empty token. Trigger the caller on `pull_request_target` instead. The job then
runs with the base repo's secrets. Both `sonar` and `sonar-scan` check out the PR head and
pass the PR number, branch and base to the scanner themselves. You do not have to change anything
else in the caller. Be aware of what that means: the fork's code is built with `SONAR_TOKEN` in the
environment. Key the caller's `concurrency` group on `github.event.pull_request.number`, not
`github.ref`, which is the base branch under `pull_request_target`.

```yaml
on:
  pull_request_target:
    types: [opened, synchronize, reopened]

concurrency:
  group: sonar-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

## `sonar-scan`

Runs SonarCloud analysis on a repo with no .NET solution. This is for the JS and shell repos,
where a scanner run does not need a build.

```yaml
  scan:
    uses: RimWorks/mod-ci/.github/workflows/sonar-scan.yml@v1
    with:
      project-key: RimWorks_your-repo
    secrets:
      SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
```

**Check Automatic Analysis first.** SonarCloud refuses a CI analysis outright when autoscan is
enabled, with `You are running CI analysis while Automatic Analysis is enabled`. Read
`sonar.autoscan.enabled` for the project before wiring this up, and only add it where autoscan is
off. A project with autoscan off and no CI analysis does not report anything at all, which is how
several of these repos sat twelve days stale with a green badge.

## `test`

Installs Node 22 and runs `npm test`. It suits a plain Node repo with no build step.

```yaml
  test:
    uses: RimWorks/mod-ci/.github/workflows/test.yml@v1
```
