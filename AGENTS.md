# AGENTS.md

## AI usage

We don't vibecode here. Use AI if it helps, but read what it wrote and understand it before
it lands. You own what ships, whether or not a model typed it.

We can't stop anyone from working the way they want to. We can set guardrails so what lands
is as good as it can be. The rest of this file is those guardrails. Run the tests, match the
code around yours, stay inside the request, and report failures instead of guessing past them.

If AI helped with a commit in any way, add an `AI-assisted: <tool name>` trailer to the
commit message.

Agents: if the user commits by hand, remind them to add the trailer.

## Project overview

`@rimworks/mod-ci` is the shared release plumbing for the RimWorks RimWorld mods. It exports
`writeStamp`, which writes `About/PublishStamp.txt` with the versions a mod was built against,
and `bumpWorkshop`, which stages a mod and pushes it to its Steam Workshop item. It also ships
a `verify-ship-list` CLI that checks a release zip actually contains everything it should.
Four repos used to run near-identical copies of these scripts and the copies drifted, which is
why this exists. See `README.md` for the consumer setup.

## Project structure

- `lib/` - the exported modules: `write-stamp.mjs`, `workshop-bump.mjs`, `ship-list.mjs`
- `bin/verify-ship-list.mjs` - the CLI
- `index.mjs` - the package entry point
- `tests/` - `node:test` suites, one per lib module
- `.github/workflows/` - release and self-scan, plus the reusable workflows consumers call:
  `codeql`, `dependabot-automerge`, `links`, `node-build`, `prose`, `ship-list`, `sonar`, `test`

## Setup & build

```bash
npm install    # Node 22+. There is no build step; this is plain ESM
```

## Testing

```bash
npm test                                # node --test tests/*.test.mjs
node --test tests/ship-list.test.mjs    # one file
node bin/verify-ship-list.mjs .         # run the checker against this repo
```

- Run the full suite before committing. All tests must pass.
- While iterating, run the single test closest to your change.
- Never delete, weaken, or rewrite a test to make a change pass.
- Do not claim that an interrupted or timed-out run passed.

## Code style

- No formatter or linter is configured. Follow the patterns already in neighboring files:
  plain ESM, `.mjs` extensions, Node built-ins over dependencies.
- Do not add comments that restate the code.
- Do not reformat code you are not otherwise changing.

## Git workflow

- Work on `main`. This repo has no feature branches and no pull requests.
- Commit format: Conventional Commits, one line, lowercase.
- Never commit, push, or open a PR unless asked.
- All CI checks must pass. semantic-release cuts a git tag from every push to `main`.

## Boundaries

- Do not modify unrelated files or widen scope beyond the request.
- Do not add dependencies without asking. `semantic-release-steam` is an optional peer
  dependency and has to stay lazily loaded, so the package imports without it.
- Never commit secrets, API keys, or .env files.
- Four mod repos pin a tag of this package. Changing an export signature breaks their
  releases, so check the consumers first and mark it as a breaking change.
- If a command fails, report the failure. Do not guess or present assumptions as confirmed
  results.
