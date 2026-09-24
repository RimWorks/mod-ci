import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { mergeReports, setNameFrom, stepSummary } from '../.github/actions/pickle-run/merge-reports.mjs';

const CLOSE = '</script>';

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
