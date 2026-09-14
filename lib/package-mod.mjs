import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function packageMod({ name, version, modPath = process.cwd(), outDir = 'dist' } = {}) {
  for (const [key, value] of Object.entries({ name, version })) {
    if (!value) throw new Error(`package-mod: ${key} is required`);
  }

  const root = resolve(modPath);
  const ignore = join(root, '.steamignore');
  if (!existsSync(ignore)) throw new Error(`package-mod: no .steamignore under ${root}`);
  if (!existsSync(join(root, 'About', 'About.xml'))) throw new Error(`package-mod: no About/About.xml under ${root}`);

  const out = resolve(root, outDir);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const stage = await mkdtemp(join(tmpdir(), 'mod-ci-'));
  const staged = join(stage, name);
  await mkdir(staged);
  const args = ['-a', '--exclude=/.steamignore', '--include=/README.md', `--exclude-from=${ignore}`];
  await run('rsync', [...args, `${root}/`, `${staged}/`]);

  const entries = (await readdir(staged)).sort();
  if (entries.length === 0) throw new Error('package-mod: .steamignore excluded everything');

  const zipPath = join(out, `${name}-${version}.zip`);
  await run('zip', ['-qr', zipPath, name], { cwd: stage });
  await rm(stage, { recursive: true, force: true });

  return { zipPath, entries };
}
