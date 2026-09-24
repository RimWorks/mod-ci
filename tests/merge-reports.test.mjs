import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { mergeReports, setNameFrom, stepSummary } from '../.github/actions/pickle-run/merge-reports.mjs';

const CLOSE = '</script>';
const run = promisify(execFile);
const script = join(import.meta.dirname, '..', '.github', 'actions', 'pickle-run', 'merge-reports.mjs');

function report(payload) {
  const json = JSON.stringify(payload).replaceAll('</', '<\\/');
  return `<!doctype html><script id="pickle-report" type="application/json">${json}${CLOSE}`;
}

function readPayload(html) {
  return JSON.parse(/type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
}

function filmed(overrides = {}) {
  return {
    setName: null,
    exitReason: 'passed',
    features: [{
      name: 'F',
      scenarios: [{
        name: 's',
        outcome: 'Passed',
        attachments: [{ name: 'film-frames', content: 'screenshots/film/f/0000.jpg' }],
      }],
    }],
    ...overrides,
  };
}

async function leg(root, dir, payload, counts) {
  const legDir = join(root, 'sets', dir);
  await mkdir(join(legDir, 'screenshots', 'film', 'f'), { recursive: true });
  await writeFile(join(legDir, 'screenshots', 'film', 'f', '0000.jpg'), 'jpg');
  await writeFile(join(legDir, 'report.html'), report(payload));
  if (counts) {
    await writeFile(join(legDir, 'summary.json'), JSON.stringify(counts));
  }

  return legDir;
}

// A leg killed mid-write leaves a report.html the payload regex cannot close.
async function brokenLeg(root, dir, html, counts) {
  const legDir = join(root, 'sets', dir);
  await mkdir(legDir, { recursive: true });
  await writeFile(join(legDir, 'report.html'), html);
  if (counts) {
    await writeFile(join(legDir, 'summary.json'), JSON.stringify(counts));
  }
}

function truncated() {
  const whole = report(filmed());
  return whole.slice(0, whole.length - CLOSE.length - 12);
}

async function workdir(t) {
  const root = await mkdtemp(join(tmpdir(), 'mod-ci-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('merges every leg in order and labels each set', async (t) => {
  const root = await workdir(t);
  await leg(root, 'compat-harmony', filmed());
  await leg(root, 'compat-concord', filmed({ exitReason: 'failed' }));

  await mergeReports(join(root, 'sets'), join(root, 'merged.html'));

  const merged = readPayload(await readFile(join(root, 'merged.html'), 'utf8'));
  assert.deepEqual(merged.sets.map((set) => set.setName), ['concord', 'harmony']);
});

test('film links and film files land on the same stripped set name', async (t) => {
  const root = await workdir(t);
  await leg(root, 'compat-vanilla', filmed());

  await mergeReports(join(root, 'sets'), join(root, 'merged.html'));

  const merged = readPayload(await readFile(join(root, 'merged.html'), 'utf8'));
  const link = merged.sets[0].features[0].scenarios[0].attachments[0].content;
  assert.equal(link, 'screenshots/vanilla/film/f/0000.jpg');
  assert.equal(await readFile(join(root, link), 'utf8'), 'jpg');
});

test('a set-name that already carries the prefix lands in the same place', async (t) => {
  const root = await workdir(t);
  await leg(root, 'vanilla', filmed({ setName: 'compat-vanilla' }));

  await mergeReports(join(root, 'sets'), join(root, 'merged.html'));

  const merged = readPayload(await readFile(join(root, 'merged.html'), 'utf8'));
  assert.equal(merged.sets[0].setName, 'vanilla');
  assert.equal(merged.sets[0].features[0].scenarios[0].attachments[0].content, 'screenshots/vanilla/film/f/0000.jpg');
  assert.equal(setNameFrom('vanilla'), 'vanilla');
});

test('a failure message holding a closing script tag cannot close the payload', async (t) => {
  const root = await workdir(t);
  await leg(root, 'harmony', filmed({
    features: [{ name: 'F', scenarios: [{ name: 's', outcome: 'Failed', failureMessage: `broke on ${CLOSE}` }] }],
  }));

  await mergeReports(join(root, 'sets'), join(root, 'merged.html'));

  const html = await readFile(join(root, 'merged.html'), 'utf8');
  assert.ok(!html.split(CLOSE)[0].includes(CLOSE));
  assert.equal(readPayload(html).sets[0].features[0].scenarios[0].failureMessage, `broke on ${CLOSE}`);
});

test('the step summary quotes counts and every failure message', async (t) => {
  const root = await workdir(t);
  const counts = { total: 2, passed: 1, failed: 1, skipped: 0, flaky: 1, exitReason: 'failed' };
  await leg(root, 'compat-vanilla', filmed({
    features: [{
      name: 'Textures',
      scenarios: [{
        name: 'a spike renders',
        outcome: 'Failed',
        failureMessage: "Could not load Texture2D at 'Things/Item/HemalurgicSpike'",
        steps: [{ keyword: 'Then', text: 'the spike renders', status: 'Failed' }],
      }],
    }],
  }), counts);

  const summary = stepSummary(await mergeReports(join(root, 'sets'), join(root, 'merged.html')));

  assert.match(summary, /\| vanilla \| 1 passed, 1 failed, 0 skipped, 1 flaky \(failed\) \|/);
  assert.match(summary, /Then the spike renders/);
  assert.match(summary, /Could not load Texture2D/);
});

test('a leg that never wrote a report still gets a row', async (t) => {
  const root = await workdir(t);
  await leg(root, 'compat-vanilla', filmed(), { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0, exitReason: 'passed' });
  await mkdir(join(root, 'sets', 'compat-dead'), { recursive: true });

  const summary = stepSummary(await mergeReports(join(root, 'sets'), join(root, 'merged.html')));

  assert.match(summary, /\| dead \| no summary\.json, this set never reported \|/);
});

test('refuses a run where no set produced a report', async (t) => {
  const root = await workdir(t);
  await mkdir(join(root, 'sets', 'compat-dead'), { recursive: true });

  await assert.rejects(mergeReports(join(root, 'sets'), join(root, 'merged.html')), /no set produced a report/);
});

test('a truncated report.html costs its own leg only, not every leg', async (t) => {
  const root = await workdir(t);
  await leg(root, 'compat-vanilla', filmed(), { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0, exitReason: 'passed' });
  await brokenLeg(root, 'compat-killed', truncated(), { total: 3, passed: 2, failed: 0, skipped: 1, flaky: 0, exitReason: 'in-progress' });

  const summary = stepSummary(await mergeReports(join(root, 'sets'), join(root, 'merged.html')));

  assert.match(summary, /\| vanilla \| 1 passed, 0 failed, 0 skipped \(passed\) \|/);
  assert.match(summary, /\| killed \| 2 passed, 0 failed, 1 skipped \(in-progress\); report\.html unreadable: /);

  // The good leg still merged, so the report is the one thing the reader can open.
  const merged = readPayload(await readFile(join(root, 'merged.html'), 'utf8'));
  assert.deepEqual(merged.sets.map((set) => set.setName), ['vanilla']);
});

test('a report.html with no payload block at all reads as unreadable', async (t) => {
  const root = await workdir(t);
  await leg(root, 'compat-vanilla', filmed(), { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0, exitReason: 'passed' });
  await brokenLeg(root, 'compat-empty', '<!doctype html><body>placeholder</body>');

  const summary = stepSummary(await mergeReports(join(root, 'sets'), join(root, 'merged.html')));

  assert.match(summary, /\| vanilla \| 1 passed, 0 failed, 0 skipped \(passed\) \|/);
  assert.match(summary, /\| empty \| no summary\.json, this set never reported; report\.html unreadable: no pickle-report payload/);
});

test('every leg unreadable still writes a step summary, and still exits non-zero', async (t) => {
  const root = await workdir(t);
  await brokenLeg(root, 'compat-killed', truncated(), { total: 2, passed: 2, failed: 0, skipped: 0, flaky: 0, exitReason: 'in-progress' });
  await brokenLeg(root, 'compat-garbled', `<!doctype html><script id="pickle-report" type="application/json">{"features":${CLOSE}`);
  const summaryFile = join(root, 'summary.md');
  await writeFile(summaryFile, '');

  const failure = await run('node', [script, join(root, 'sets'), join(root, 'merged.html')], {
    env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile },
  }).then(() => null, (err) => err);

  assert.ok(failure, 'a run that merged nothing must not exit 0');
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /::error title=Pickle merge::no set produced a report/);

  const summary = await readFile(summaryFile, 'utf8');
  assert.match(summary, /\| killed \| 2 passed, 0 failed, 0 skipped \(in-progress\); report\.html unreadable: /);
  assert.match(summary, /\| garbled \| no summary\.json, this set never reported; report\.html unreadable: /);
  assert.match(summary, /The merge failed: no set produced a report/);
});

test('a run with no set directories at all still says so in the summary', async (t) => {
  const root = await workdir(t);
  await mkdir(join(root, 'sets'), { recursive: true });
  const summaryFile = join(root, 'summary.md');
  await writeFile(summaryFile, '');

  const failure = await run('node', [script, join(root, 'sets'), join(root, 'merged.html')], {
    env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile },
  }).then(() => null, (err) => err);

  assert.equal(failure.code, 1);
  assert.match(await readFile(summaryFile, 'utf8'), /no set uploaded anything to merge/);
});

test('an unreadable set is named as missing from Compare sets', () => {
  const counts = { passed: 1, failed: 0, skipped: 0, flaky: 0, exitReason: 'passed' };
  const summary = stepSummary([
    { name: 'vanilla', counts, failures: [] },
    { name: 'royalty', counts, failures: [], unreadable: 'no payload in report.html' },
  ]);

  assert.match(summary, /Missing from Compare sets: royalty/);
  assert.doesNotMatch(summary, /Missing from Compare sets: [^\n]*vanilla/);
});

test('no missing-column line when the merge itself failed', () => {
  const summary = stepSummary(
    [{ name: 'royalty', counts: null, failures: [], unreadable: 'truncated' }],
    'every set was unreadable',
  );

  assert.doesNotMatch(summary, /Missing from Compare sets/);
});

test('every leg lacking a summary.json names the nested-artifact cause', async () => {
  const root = await mkdtemp(join(tmpdir(), 'merge-nested-'));
  try {
    // what a two-path upload produces: the report dir one level below where a leg is read
    for (const leg of ['harmony', 'concord']) {
      await mkdir(join(root, 'sets', leg, 'pickle-reports'), { recursive: true });
      await writeFile(join(root, 'sets', leg, 'pickle-reports', 'report.html'), 'x');
    }

    await assert.rejects(
      mergeReports(join(root, 'sets'), join(root, 'merged.html')),
      /exactly one path, ending in a slash/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a leg with counts but no template does not blame the artifact shape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'merge-nohint-'));
  try {
    await mkdir(join(root, 'sets', 'harmony'), { recursive: true });
    await writeFile(join(root, 'sets', 'harmony', 'summary.json'), JSON.stringify(
      { passed: 1, failed: 0, skipped: 0, flaky: 0, total: 1, exitReason: 'passed' },
    ));

    await assert.rejects(
      mergeReports(join(root, 'sets'), join(root, 'merged.html')),
      (err) => err.message === 'no set produced a report',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
