import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { decide } from '../.github/actions/pickle-run/verdict.mjs';

const XIO = 'XIO:  fatal IO error 11 (Resource temporarily unavailable) on X server ":99"';

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
  const old = new Date(Date.now() - 120_000);
  await utimes(join(run.dir, 'summary.json'), old, old);
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  const { code, markdown } = decide(run);

  assert.equal(code, 1);
  assert.match(markdown, /never reported/);
});

test('fails without a retry when nothing reported and no X message', async (t) => {
  const run = await fixture({ 'container.log': 'oom killed\n' });
  t.after(() => rm(run.dir, { recursive: true, force: true }));

  const { code, markdown } = decide({ ...run, status: 137 });

  assert.equal(code, 1);
  assert.match(markdown, /oom killed/);
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

  assert.equal(code, 1);
  assert.match(markdown, /No stamp file/);
});
