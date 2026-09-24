import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CHECK_ORDER, decide } from '../.github/actions/pickle-run/verdict.mjs';

const XIO = 'XIO:  fatal IO error 11 (Resource temporarily unavailable) on X server ":99"';

// pickle rewrites report.html on an interval, so a container killed mid-write leaves one of these:
// cut before the closing tag, or cut inside the json with the tag still there.
const CUT_OFF = '<html><script id="pickle-report" type="application/json">{"features":[{"name":"load';
const CUT_JSON = '<html><script id="pickle-report" type="application/json">{"features":[{</script></html>';

function html(payload) {
  const json = JSON.stringify(payload).replace(/<\//g, '<\\/');
  return `<html><script id="pickle-report" type="application/json">${json}</script></html>`;
}

function scenario(name, message, step = 'the mod loads') {
  return {
    name,
    outcome: 'Failed',
    failureMessage: message,
    steps: [{ keyword: 'Then', text: step, status: 'Failed' }],
  };
}

// stamp first, then every report file, so mtimes order the way a real run leaves them
async function fixture(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mod-ci-verdict-'));
  const stamp = join(dir, 'stamp');
  await writeFile(stamp, '');
  const old = new Date(Date.now() - 60_000);
  await utimes(stamp, old, old);

  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return { dir, stamp, containerLog: join(dir, 'container.log') };
}

// older than the stamp fixture() wrote, so the file reads as a previous attempt's leftover
async function backdate(dir, name) {
  const old = new Date(Date.now() - 120_000);
  await utimes(join(dir, name), old, old);
}

const passing = { total: 3, passed: 3, failed: 0, skipped: 0, flaky: 0, exitReason: 'passed' };

test('passes a clean run', async (t) => {
  const run = await fixture({ 'summary.json': passing, 'report.html': html({ features: [] }) });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  const { code, markdown } = decide(run);

  assert.equal(code, 0);
  assert.match(markdown, /All 3 scenarios passed/);
});

test('retries when the X server died before anything reported', async (t) => {
  const run = await fixture({ 'Player.log': `boot\n${XIO}\n` });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  assert.equal(decide(run).code, 75);
});

test('finds the X death in the container log too', async (t) => {
  const run = await fixture({ 'container.log': 'Desktop is 0 x 0\n' });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  assert.equal(decide(run).code, 75);
});

test('a stale summary.json is not this run reporting', async (t) => {
  const run = await fixture({ 'summary.json': passing, 'container.log': 'line\n' });
  await backdate(run.dir, 'summary.json');
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  const { code, markdown } = decide(run);

  assert.equal(code, 2);
  assert.match(markdown, /never reported/);
});

test("a previous attempt's X death does not retry this one", async (t) => {
  const run = await fixture({ 'Player.log': `boot\n${XIO}\n`, 'container.log': 'docker: pull denied (403)\n' });
  await backdate(run.dir, 'Player.log');
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  const { code, markdown } = decide(run);

  assert.equal(code, 2);
  assert.match(markdown, /never reported/);
  assert.match(markdown, /pull denied \(403\)/);
});

test('the same X death newer than the stamp still retries', async (t) => {
  const run = await fixture({ 'Player.log': `boot\n${XIO}\n`, 'container.log': 'docker: pull denied (403)\n' });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  assert.equal(decide(run).code, 75);
});

test('a stale log reads as stale, not as one that could not be read', async (t) => {
  const run = await fixture({ 'Player.log': `${XIO}\n`, 'container.log': 'mount source does not exist\n' });
  await backdate(run.dir, 'Player.log');
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  const { code, markdown, notices } = decide(run);

  assert.equal(code, 2);
  assert.match(markdown, /Player\.log` predates the stamp/);
  assert.ok(!markdown.includes('ran blind'));
  assert.deepEqual(notices, []);
});

test("a previous attempt's report.html counts as absent", async (t) => {
  const run = await fixture({ 'summary.json': passing, 'report.html': html({ features: [] }) });
  await backdate(run.dir, 'report.html');
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  const { code, markdown } = decide(run);

  assert.equal(code, 1);
  assert.match(markdown, /failed partway/);
});

test('fails without a retry when nothing reported and no X message', async (t) => {
  const run = await fixture({ 'container.log': 'oom killed\n' });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  const { code, markdown } = decide({ ...run, status: 137 });

  assert.equal(code, 2);
  assert.match(markdown, /oom killed/);
});

test('a missing container log is reported, not read as "no X death"', async (t) => {
  const run = await fixture({});
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  const { code, markdown, notices } = decide(run);

  assert.equal(code, 2);
  assert.match(markdown, /No container log to grep/);
  assert.match(markdown, /ran blind/);
  assert.match(notices[0], /^::error title=Pickle container log missing::/);
});

test('an empty container log counts as unread, not as a clean grep', async (t) => {
  const run = await fixture({ 'container.log': '' });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  const { code, markdown } = decide(run);

  assert.equal(code, 2);
  assert.match(markdown, /ran blind/);
});

test('the X pattern tolerates the two spaces xlib actually writes', async (t) => {
  // a literal one-space pattern matches nothing in a real log and turns every retry off silently
  assert.ok(!/XIO: fatal IO error/.test(XIO));

  const run = await fixture({ 'Player.log': `${XIO}\n`, 'container.log': 'boot\n' });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  assert.equal(decide(run).code, 75);
});

test('a scenario failure never reaches a retry, even with an X death in the log', async (t) => {
  const run = await fixture({
    'summary.json': { total: 2, passed: 1, failed: 1, skipped: 0, flaky: 0, exitReason: 'failed' },
    'report.html': html({ features: [{ name: 'load.feature', mod: 'Cosmere - Core', scenarios: [scenario('loads', 'boom')] }] }),
    'Player.log': `${XIO}\n`,
  });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  assert.equal(decide(run).code, 1);
});

test('names the failing step and its message in the table', async (t) => {
  const message = "Could not load Texture2D at 'Things/Item/HemalurgicSpike'";
  const run = await fixture({
    'summary.json': { total: 73, passed: 66, failed: 7, skipped: 0, flaky: 0, exitReason: 'failed' },
    'report.html': html({
      features: [{ name: 'spike.feature', mod: 'Cosmere - Core', scenarios: [scenario('spawns a spike', message)] }],
    }),
  });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  const { code, markdown } = decide(run);

  assert.equal(code, 1);
  assert.match(markdown, /7 of 73 scenarios failed/);
  assert.match(markdown, /\| spike\.feature \| Cosmere - Core \| spawns a spike \| Then the mod loads \| Could not load/);
});

test('a green run with an unreadable report.html passes, but never silently', async (t) => {
  const run = await fixture({ 'summary.json': passing, 'report.html': CUT_OFF });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  const { code, markdown, notices } = decide(run);

  assert.equal(code, 0);
  assert.match(markdown, /All 3 scenarios passed/);
  assert.match(markdown, /No failure table: report\.html carries no pickle-report payload/);
  assert.match(notices[0], /^::warning title=Pickle report\.html unreadable::/);
});

test('an unreadable report.html still fails a run with failures, and says why there is no table', async (t) => {
  const run = await fixture({
    'summary.json': { total: 5, passed: 3, failed: 2, skipped: 0, flaky: 0, exitReason: 'failed' },
    'report.html': CUT_JSON,
  });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  const { code, markdown } = decide(run);

  assert.equal(code, 1);
  assert.match(markdown, /2 of 5 scenarios failed/);
  assert.match(markdown, /No failure table: report\.html payload is not readable/);
});

test('fails when the report write threw before report.html', async (t) => {
  const run = await fixture({ 'summary.json': passing });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  const { code, markdown } = decide(run);

  assert.equal(code, 1);
  assert.match(markdown, /failed partway/);
});

test('an empty run prints what the filter should have matched', async (t) => {
  const run = await fixture({
    'summary.json': { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, exitReason: 'infrastructure-error' },
    'report.html': html({ features: [] }),
    'Player.log': [
      'some engine noise',
      "pickle: filter 'Cosmre' matched no scenarios.",
      '  3 features in Pickle: a.feature, b.feature, c.feature',
      '  terms are @tag, mod name, feature path, path::name, path:line, or ::name',
      'unrelated trailing line',
    ].join('\n'),
  });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  const { code, markdown } = decide(run);

  assert.equal(code, 1);
  assert.match(markdown, /Zero scenarios ran/);
  assert.match(markdown, /3 features in Pickle/);
  assert.ok(!markdown.includes('unrelated trailing line'));
});

test('labels the counts partial when the watchdog killed the run', async (t) => {
  const run = await fixture({
    'summary.json': { total: 11, passed: 11, failed: 0, skipped: 0, flaky: 0, exitReason: 'watchdog-timeout' },
    'report.html': html({ features: [] }),
  });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  const { code, markdown } = decide(run);

  assert.equal(code, 1);
  assert.match(markdown, /counts are partial/);
});

test('a nonzero container exit alone passes with a notice', async (t) => {
  const run = await fixture({ 'summary.json': passing, 'report.html': html({ features: [] }) });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  const { code, notices } = decide({ ...run, status: 1 });

  assert.equal(code, 0);
  assert.match(notices[0], /^::notice title=Pickle container exit 1::/);
});

test('flaky scenarios pass and get counted', async (t) => {
  const run = await fixture({
    'summary.json': { total: 3, passed: 3, failed: 0, skipped: 0, flaky: 2, exitReason: 'passed' },
    'report.html': html({ features: [] }),
  });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  const { code, markdown } = decide(run);

  assert.equal(code, 0);
  assert.match(markdown, /2 scenario\(s\) failed at least once/);
});

test('refuses to judge without a stamp', async (t) => {
  const run = await fixture({ 'summary.json': passing, 'report.html': html({ features: [] }) });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  const { code, markdown } = decide({ ...run, stamp: join(run.dir, 'nope') });

  assert.equal(code, 2);
  assert.match(markdown, /No stamp file/);
});

test('a Player.log with no boot line says Pickle never loaded', async (t) => {
  const run = await fixture({ 'Player.log': 'Mono path[0] = ...\nvanilla boot\n', 'container.log': 'exit 0\n' });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  const { code, markdown } = decide(run);

  assert.equal(code, 2);
  assert.match(markdown, /Pickle never loaded/);
  assert.match(markdown, /ModsConfig\.xml/);
});

test('a decorated boot line still counts as loaded', async (t) => {
  // RimLogging wraps the line differently by config, so the match cannot be anchored
  const decorated = '<color=#A5C2A5>[2026-09-07 02:15:37.708] [INFO] [default] [PickleMod:22] </color>pickle: loaded\n';
  const run = await fixture({ 'Player.log': decorated, 'container.log': 'exit 1\n' });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  const { markdown } = decide(run);

  assert.doesNotMatch(markdown, /Pickle never loaded/);
});

test('a bare boot line counts as loaded', async (t) => {
  const run = await fixture({ 'Player.log': 'pickle: loaded\n', 'container.log': 'exit 1\n' });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  assert.doesNotMatch(decide(run).markdown, /Pickle never loaded/);
});

test('a leg that reported keeps exit 1, so a comparison leg can absorb it', async (t) => {
  const run = await fixture({
    'summary.json': JSON.stringify({ total: 2, passed: 1, failed: 1, skipped: 0, flaky: 0, exitReason: 'failed' }),
    'report.html': '<html></html>',
    'container.log': 'exit 1\n',
  });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  assert.equal(decide(run).code, 1);
});


// the nine checks are a list now, so nothing but this stops a reorder
test('the nine checks keep their order and their numbers', () => {
  assert.deepEqual(CHECK_ORDER, [
    '1:no-stamp',
    '2:never-reported',
    '3:unreadable-summary',
    '4:report-write-threw',
    '5:zero-scenarios',
    '6:scenarios-failed',
    '7:did-not-finish',
    '8:passed',
  ]);
});

test('only the first three checks can reach a retry', () => {
  const src = readFileSync(
    join(import.meta.dirname, '..', '.github', 'actions', 'pickle-run', 'verdict.mjs'),
    'utf8',
  );
  const verdicts = src.slice(src.indexOf('const VERDICTS = ['), src.indexOf('function judgeNoReport'));

  assert.ok(!verdicts.includes('EXIT_RETRY'), 'a VERDICTS entry can retry, so a failed scenario could loop');
  assert.ok(!verdicts.includes('75'), 'a VERDICTS entry returns 75 literally');
});
