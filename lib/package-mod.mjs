import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Never mod content in any repo, so a repo's .steamignore only lists what is its own. Three
 * repos had drifted here and one shipped its AI tooling into the zip.
 */
export const NEVER_SHIPPED = [
  '.git',
  '.github',
  '.gitattributes',
  '.gitignore',
  '.editorconfig',
  '.idea',
  '.vs',
  '.claude',
  '.gitnexus',
  '.serena',
  '.desloppify',
  '.mcp.json',
  '.gamecrate.yml',
  '.vale.ini',
  'lychee.toml',
  'Styles',
  'Source',
  'scripts',
  'node_modules',
  'bin',
  'obj',
  'dist',
  'artifacts',
  'nupkgs',
  'out',
  'package.json',
  'package-lock.json',
  'release.config.mjs',
  'game.log',
  '*.sln',
  '*.slnx',
  '*.pdb',
  '*.zip',
  '*.xcf',
  '*.md',
];

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
  const args = [
    '-a',
    '--include=/README.md',
    '--exclude=/.steamignore',
    ...NEVER_SHIPPED.map((p) => `--exclude=${p}`),
    `--exclude-from=${ignore}`,
  ];
  await run('rsync', [...args, `${root}/`, `${staged}/`]);

  const entries = (await readdir(staged)).sort();
  if (entries.length === 0) throw new Error('package-mod: .steamignore excluded everything');

  const zipPath = join(out, `${name}-${version}.zip`);
  await run('zip', ['-qr', zipPath, name], { cwd: stage });
  await rm(stage, { recursive: true, force: true });

  return { zipPath, entries };
}
