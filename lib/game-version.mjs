import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The game's own Version.txt, which is the only place the build number is authoritative. */
export async function gameVersion(refsDir) {
  if (!refsDir) throw new Error('gameVersion needs a refs directory');

  let text;
  try {
    text = await readFile(join(refsDir, 'Version.txt'), 'utf8');
  } catch {
    throw new Error(`no Version.txt under ${refsDir}`);
  }

  // gamecrate reads the same two leading numbers off the same file, so the shapes both
  // accept have to match: leading blank lines skipped, first line only, and a bare "1.6" is valid
  const full = text.trim().split('\n')[0].trim();
  const hit = /^(\d+\.\d+)/.exec(full);
  if (!hit) throw new Error(`unreadable Version.txt under ${refsDir}: ${full}`);

  return { full, short: hit[1] };
}
