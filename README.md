# @rimworks/mod-ci

Shared release plumbing for the RimWorks RimWorld mods: publish stamps, Steam Workshop bumps,
release-zip checks, Discord announcements, and the CI workflows that run them.

Used by [RimLogging][rl], [Pickle][pk] and [Quickstarts][qs].

## Install

```bash
npm install --save-dev github:RimWorks/mod-ci#v2
```

This package is not on npm. Consumers install from a git tag, so a release never has to push a
version commit back to a protected branch.

`bumpWorkshop` also needs `semantic-release-steam`. It is an optional peer dependency. Install it
only in repos that publish to the Steam Workshop.

## A mod repo's release config

One call declares what the repo contains. [`releaseConfig`](docs/modules.md#releaseconfig) decides
how the release runs.

```js
import { readFileSync } from 'node:fs';

import { declaredVersions, releaseConfig } from '@rimworks/mod-ci';

export default releaseConfig({
  solution: 'Quickstarts.slnx',
  versions: declaredVersions(readFileSync('loadFolders.xml', 'utf8')),
  mods: [{ name: 'Quickstarts', workshopId: '3793646067' }],
});
```

## Documentation

| Page | What's in it |
| --- | --- |
| [Modules](docs/modules.md) | Functions the package exports, including `releaseConfig` |
| [CLI](docs/cli.md) | `build-mod`, `write-stamp`, `workshop-bump`, `package-mod`, `verify-ship-list`, `discord-release` |
| [Reusable workflows](docs/workflows.md) | Workflows a consumer calls with `uses:`, and the token scopes each needs |
| [Composite actions](docs/actions.md) | Per-step actions, such as `stage-game-refs` and `steam-login` |
| [Multi-version mods](docs/multi-version.md) | How one commit builds for 1.5 and 1.6, and why there is no reference package |

## Pinning

Pin workflows and actions to the major tag, `v2`. `semantic-release-github-actions-tags` moves
`v2` and the minor tag to each new release. A consumer picks up fixes without a bump. It never
picks up a breaking change.

Actions inside these workflows are pinned to their major tag too, not to a commit SHA. A SHA never
picks up a security fix on its own, and every consumer then waits on a release here. Because of
that, `codeql` excludes the `actions/unpinned-tag` query. Without the exclusion it reports every
workflow in every consumer.

## Development

```bash
npm test
```

Tests use the built-in Node test runner, so there is nothing else to install.

[rl]: https://github.com/RimWorks/rimworld-logging-framework
[pk]: https://github.com/RimWorks/Rimworld-Pickle
[qs]: https://github.com/RimWorks/Rimworld-Quickstarts
