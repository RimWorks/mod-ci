import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const WORKFLOW = new URL('../.github/workflows/game-image.yml', import.meta.url);

test('every job that logs in to steam waits in one queue, so an account holds one session at a time', async () => {
  const yaml = await readFile(WORKFLOW, 'utf8');
  const jobs = yaml.slice(yaml.indexOf('\njobs:\n')).split(/\n(?= {2}[a-z][a-z-]*:\n)/).slice(1);
  const loggingIn = jobs.filter((job) => job.includes('RimWorks/steam-game-image-action@'));

  assert.equal(loggingIn.length, 2, 'the linux and windows image jobs are the ones that log in');
  for (const job of loggingIn) {
    assert.match(job, /\n {4}concurrency:\n {6}group: steam-login\n {6}queue: max\n/);
  }
});
