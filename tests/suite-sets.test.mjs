import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const WORKFLOW = new URL('../.github/workflows/pickle-suite.yml', import.meta.url);

async function setsScript() {
  const yaml = await readFile(WORKFLOW, 'utf8');
  const step = yaml.slice(yaml.indexOf('- name: Read the sets'));
  const body = step.slice(step.indexOf('run: |') + 'run: |\n'.length);
  const lines = [];
  for (const line of body.split('\n')) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    lines.push(line.slice(10));
  }
  const script = lines.join('\n');
  assert.ok(script.includes('SET_SUFFIX'), 'lifted the wrong step out of the workflow');
  return script;
}

async function readSets(env) {
  const script = await setsScript();
  const outputs = join(tmpdir(), `sets-${process.pid}-${Math.random().toString(36).slice(2)}`);
  await run('bash', ['-c', script], {
    env: { ...process.env, GITHUB_OUTPUT: outputs, BACKENDS: '[]', SET_SUFFIX: '', MOD_SETS: '',
      STAGED_MODS: '', WORKSHOP_MODS: '', ...env },
  }).catch(e => { throw new Error(e.stderr || e.stdout); });

  const written = await readFile(outputs, 'utf8');
  return JSON.parse(written.match(/matrix=(.*)/)[1]).set;
}

test('derives one leg per backend, named after it', async () => {
  assert.deepEqual((await readSets({ BACKENDS: '["harmony","concord"]' })).map(s => s.name),
    ['harmony', 'concord']);
});

test('appends set-suffix, so two callers in one run upload under different artifacts', async () => {
  const set = await readSets({ BACKENDS: '["harmony","concord"]', SET_SUFFIX: '-17' });

  assert.deepEqual(set.map(s => s.name), ['harmony-17', 'concord-17']);
  assert.deepEqual(set.map(s => s.backend), ['harmony', 'concord'],
    'the suffix names the artifact and must not reach the backend the leg runs');
});

test('leaves a mod-sets name alone, because the caller already chose it', async () => {
  const set = await readSets({
    MOD_SETS: '[{"name":"vanilla","backend":"harmony"}]', SET_SUFFIX: '-17' });

  assert.deepEqual(set.map(s => s.name), ['vanilla']);
});

test('two legs sharing a name still die before the run starts', async () => {
  await assert.rejects(readSets({ BACKENDS: '["harmony","harmony"]' }), /repeat/);
});

test('the suite job takes its runner from the input, so a gpu host stays reachable', async () => {
  const yaml = await readFile(WORKFLOW, 'utf8');
  const job = yaml.slice(yaml.indexOf('\n  suite:'), yaml.indexOf('\n  merge:'));

  assert.match(job, /runs-on: \$\{\{ inputs\.runs-on \}\}/,
    'a hardcoded runner sends a vulkan game version back to software rendering');
  assert.match(yaml, /^ {6}runs-on:\n {8}description:.+\n {8}type: string\n {8}default: ubuntu-latest$/m,
    'the input has to default to the hosted runner, or every existing caller changes behaviour');
});

test('a suffix carrying a character an artifact name cannot hold dies', async () => {
  await assert.rejects(readSets({ BACKENDS: '["harmony"]', SET_SUFFIX: '/1.7' }), /cannot hold/);
});
