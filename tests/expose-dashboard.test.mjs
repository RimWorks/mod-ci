import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = join(import.meta.dirname, '..', '.github', 'actions', 'pickle-run', 'expose-dashboard.sh');

// Stubs for everything that would reach the network, so the suite needs none.
async function tunnel(env) {
  const root = await mkdtemp(join(tmpdir(), 'expose-dashboard-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  // curl doubles as the download and the port probe: write whatever -o names, succeed.
  await writeFile(join(bin, 'curl'), [
    '#!/usr/bin/env bash',
    'dest=""; while (( $# )); do [[ "$1" == "-o" ]] && dest="$2"; shift; done',
    '[[ -z "$dest" || "$dest" == /dev/null ]] && exit 0',
    'printf "#!/usr/bin/env bash\\necho https://stub-tunnel.trycloudflare.com\\nsleep 30\\n" > "$dest"',
  ].join('\n'));
  await writeFile(join(bin, 'sha256sum'), '#!/usr/bin/env bash\ncat > /dev/null\nexit 0\n');
  for (const stub of ['curl', 'sha256sum']) await chmod(join(bin, stub), 0o755);

  const summary = join(root, 'summary.md');
  await writeFile(summary, '');
  const result = await run('timeout', ['-s', 'KILL', '6', 'bash', script], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: root,
      GITHUB_STEP_SUMMARY: summary,
      ...env,
    },
  }).catch((err) => err);
  return { root, stdout: result.stdout, summary: await readFile(summary, 'utf8') };
}

test('labels the URL with the set name so a matrix has one findable link per leg', async () => {
  const { stdout, summary } = await tunnel({ SET_NAME: 'concord', DASHBOARD_PORT: '27752' });
  assert.match(stdout, /::notice title=Pickle dashboard \(concord\)::https:\/\/stub-tunnel\.trycloudflare\.com/);
  assert.match(summary, /- \*\*concord\*\* live dashboard: https:\/\/stub-tunnel\.trycloudflare\.com/);
});

test('takes the port from the environment, so two legs never share one tunnel', async () => {
  const { root } = await tunnel({ DASHBOARD_PORT: '27753' });
  await readFile(join(root, 'cloudflared-27753.log'), 'utf8');
});
