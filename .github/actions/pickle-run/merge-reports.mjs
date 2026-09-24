#!/usr/bin/env node
// merge-reports.mjs <sets-dir> [out.html]
//
// Every report carries its whole run in one <script id="pickle-report">, so merging never
// renders anything: it reads each payload, tags it with its set name, and writes them all back
// as {"sets": [...]} into a copy of the first file.
import { existsSync } from 'node:fs';
import { appendFile, cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PAYLOAD = /(<script id="pickle-report" type="application\/json">)([\s\S]*?)(<\/script>)/;
const FILM_PREFIX = 'screenshots/film/';
const MESSAGE_LIMIT = 300;
const FAILURE_ROWS = 50;

// The artifact is uploaded as compat-<set> while the films land under the bare name. Both halves
// strip the prefix here, so nothing outside this file can aim the links at a folder that is empty.
export const setNameFrom = (raw) => raw.replace(/^compat-/, '');

// BuildPayload escapes </ so a failure message cannot close the script tag it lives in.
// JSON.parse decodes \/ on its own, so only the write side has to put it back.
const escape = (text) => text.replaceAll('</', '<\\/');

function readPayload(html) {
  const match = PAYLOAD.exec(html);
  if (!match) {
    throw new Error('no pickle-report payload in this file');
  }

  return JSON.parse(match[2]);
}

// Films are linked, not inlined, so two sets would otherwise claim the same folder.
function prefixFilmPaths(payload, name) {
  for (const feature of payload.features ?? []) {
    for (const scenario of feature.scenarios ?? []) {
      for (const attachment of scenario.attachments ?? []) {
        const content = attachment.content ?? '';
        if (content.startsWith(FILM_PREFIX)) {
          attachment.content = `screenshots/${name}/film/${content.slice(FILM_PREFIX.length)}`;
        }
      }
    }
  }
}

function failuresOf(payload) {
  const rows = [];
  for (const feature of payload.features ?? []) {
    for (const scenario of feature.scenarios ?? []) {
      if (scenario.outcome !== 'Failed') {
        continue;
      }

      const step = (scenario.steps ?? []).find((s) => s.status === 'Failed');
      rows.push({
        feature: feature.name ?? '',
        scenario: scenario.name ?? '',
        step: step ? `${step.keyword} ${step.text}`.trim() : '',
        message: scenario.failureMessage ?? step?.failureMessage ?? '',
      });
    }
  }

  return rows;
}

async function readJson(path) {
  return existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) : null;
}

export async function mergeReports(setsDir, out = 'merged.html') {
  const dirs = (await readdir(setsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const sets = [];
  let template = null;

  for (const dir of dirs) {
    const legDir = join(setsDir, dir);
    const counts = await readJson(join(legDir, 'summary.json'));
    const reportPath = join(legDir, 'report.html');

    // A leg that died before WriteReports still gets a row: it is the only sign it ran at all.
    if (!existsSync(reportPath)) {
      sets.push({ name: setNameFrom(counts?.setName || dir), counts, failures: [] });
      continue;
    }

    const html = await readFile(reportPath, 'utf8');
    template ??= html;

    const payload = readPayload(html);
    const name = setNameFrom(payload.setName || dir);
    payload.setName = name;
    prefixFilmPaths(payload, name);

    const films = join(legDir, 'screenshots', 'film');
    if (existsSync(films)) {
      const dest = join(dirname(out), 'screenshots', name, 'film');
      await mkdir(dirname(dest), { recursive: true });
      await cp(films, dest, { recursive: true });
    }

    sets.push({ name, counts, failures: failuresOf(payload), payload });
  }

  if (!template) {
    throw new Error('no set produced a report');
  }

  const merged = escape(JSON.stringify({ sets: sets.filter((set) => set.payload).map((set) => set.payload) }));
  await writeFile(out, template.replace(PAYLOAD, (_match, open, _body, close) => open + merged + close), 'utf8');

  return sets;
}

// Markdown eats a pipe and a step summary renders raw html, so a failure message quoting
// <Thing> has to arrive escaped or it vanishes from the table.
function cell(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const cut = flat.length > MESSAGE_LIMIT ? `${flat.slice(0, MESSAGE_LIMIT)}...` : flat;
  return cut.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '\\|');
}

function result({ counts }) {
  if (!counts) {
    return 'no summary.json, this set never reported';
  }

  const flaky = counts.flaky > 0 ? `, ${counts.flaky} flaky` : '';
  return `${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped${flaky} (${counts.exitReason})`;
}

export function stepSummary(sets) {
  const lines = ['## Pickle sets', '', '| Set | Result |', '|---|---|'];
  for (const set of sets) {
    lines.push(`| ${cell(set.name)} | ${result(set)} |`);
  }

  // Counts alone send a reader off to download an artifact to learn what broke.
  const failed = sets.flatMap((set) => set.failures.map((row) => ({ ...row, set: set.name })));
  if (failed.length > 0) {
    lines.push('', '| Set | Feature | Scenario | Failing step | Message |', '|---|---|---|---|---|');
    for (const row of failed.slice(0, FAILURE_ROWS)) {
      lines.push(`| ${cell(row.set)} | ${cell(row.feature)} | ${cell(row.scenario)} | ${cell(row.step)} | ${cell(row.message)} |`);
    }

    if (failed.length > FAILURE_ROWS) {
      lines.push('', `${failed.length - FAILURE_ROWS} more failing scenarios are in the merged report.`);
    }
  }

  lines.push('', 'Download **merged-report** below and open `merged.html`. Select **Compare sets** to see which scenario broke under which set.');
  return `${lines.join('\n')}\n`;
}

async function main([setsDir, out = 'merged.html']) {
  if (!setsDir) {
    console.error('usage: merge-reports.mjs <sets-dir> [out.html]');
    return 2;
  }

  let sets;
  try {
    sets = await mergeReports(setsDir, out);
  } catch (err) {
    console.error(`::error title=Pickle merge::${err.message}`);
    return 1;
  }

  const summary = stepSummary(sets);
  await (process.env.GITHUB_STEP_SUMMARY
    ? appendFile(process.env.GITHUB_STEP_SUMMARY, summary, 'utf8')
    : process.stdout.write(summary));

  console.log(`merge-reports: ${sets.length} set(s) -> ${out}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
