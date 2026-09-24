#!/usr/bin/env node
// Decides pass, fail or retry after a Pickle container run, and writes the GitHub step summary.
// Counts come from summary.json; step text and failure messages come from the payload inside
// report.html, the only report file carrying either.
// argv first, then env: <report-dir> REPORT_DIR, <status> RUN_STATUS, <stamp> STAMP_FILE,
// <container-log> CONTAINER_LOG. Exits 0 pass, 75 retry the container, 1 fail.

import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXIT_FAIL = 1;
const EXIT_RETRY = 75;

// Xlib writes `XIO:  fatal IO error 11 (...)` with TWO spaces, and a literal one-space pattern
// matches nothing at all, silently turning off every retry. \s+ so retyping cannot lose them.
const X_SERVER_DIED = /XIO:\s+fatal IO error|Desktop is 0 x 0/;

// Watchdog.Trip and a killed run both leave counts for a suite that never finished.
const PARTIAL_REASONS = new Set(['in-progress', 'watchdog-timeout']);

const MESSAGE_CHARS = 400;

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function mtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// HtmlReportWriter escapes the payload's own "</" as "<\/", so the first closing tag is ours.
function readPayload(html) {
  const tag = html.indexOf('id="pickle-report"');
  if (tag < 0) return null;
  const start = html.indexOf('>', tag) + 1;
  const end = html.indexOf('</script>', start);
  if (start === 0 || end < 0) return null;
  return JSON.parse(html.slice(start, end));
}

function cell(text, limit = 0) {
  let value = String(text ?? '');
  if (limit > 0 && value.length > limit) value = `${value.slice(0, limit)} ...`;
  return value
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/\r?\n/g, '<br>');
}

function failingStep(steps) {
  const step = (steps ?? []).find((s) => s.status === 'Failed');
  return step ? `${step.keyword} ${step.text}` : '(no step failed - a hook or the run itself did)';
}

function tail(path, count) {
  const text = read(path);
  if (!text) return null;
  return text.split('\n').filter(Boolean).slice(-count).join('\n');
}

function xServerDied(paths) {
  return paths.some((path) => {
    const text = read(path);
    return text != null && X_SERVER_DIED.test(text);
  });
}

// ScenarioFilter.DescribeNoMatch lists every discovered feature grouped by mod plus the legal
// term forms, and it only ever reaches the log.
function filterHelp(path) {
  const text = read(path);
  if (!text) return null;

  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  const start = lines.findIndex((line) => line.includes("pickle: filter '"));
  if (start < 0) return null;

  const block = [lines[start].slice(lines[start].indexOf('pickle: filter'))];
  for (const line of lines.slice(start + 1)) {
    if (!/^ {2}\S/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

function failuresFrom(payload) {
  const failures = [];
  for (const feature of payload.features ?? []) {
    for (const scenario of feature.scenarios ?? []) {
      if (scenario.outcome !== 'Failed') continue;
      failures.push({
        // ScenarioResult drops SourcePath, so path is the feature name today. First anyway,
        // to pick a real one up for free if Pickle ever adds it.
        feature: feature.path || feature.name || '(unnamed feature)',
        mod: feature.mod || '-',
        scenario: scenario.name,
        step: failingStep(scenario.steps),
        message: scenario.failureMessage || '(no message)',
      });
    }
  }
  return failures;
}

function done(code, lines, notices = []) {
  return { code, markdown: `${['## Pickle suite', '', ...lines].join('\n')}\n`, notices };
}

/**
 * Judges one container run from its report directory.
 *
 * @param {object} run The run to judge.
 * @param {string} run.dir Report directory holding summary.json, report.html and Player.log.
 * @param {number} run.status Exit code the container returned.
 * @param {string} run.stamp File the caller created before docker run.
 * @param {string} run.containerLog Where the container's stdout was captured.
 * @returns {{code: number, markdown: string, notices: string[]}} Exit code, the step summary to
 *   write, and any workflow commands to print.
 */
export function decide({ dir, status = 0, stamp, containerLog } = {}) {
  const summaryPath = join(dir, 'summary.json');
  const htmlPath = join(dir, 'report.html');
  const playerLog = join(dir, 'Player.log');

  // 1. the stamp is the only way to tell this run's report from a previous attempt's.
  const stampMs = mtime(stamp);
  if (stampMs === null) {
    return done(EXIT_FAIL, [`**No stamp file at \`${stamp}\`.** The caller has to \`mktemp\` one before \`docker run\`.`]);
  }

  // 2. the last point a retry is possible. Everything below had a report to read.
  const summaryMs = mtime(summaryPath);
  if (summaryMs === null || summaryMs <= stampMs) {
    if (xServerDied([playerLog, containerLog])) {
      return done(EXIT_RETRY, [
        '**The X server died before the suite reported.** That is a flake, worth one retry.',
        '',
        `Container exit ${status}, no summary.json newer than the stamp.`,
      ]);
    }

    const lines = [
      '**This run never reported.**',
      '',
      `No summary.json under \`${dir}\` newer than the stamp, and nothing in Player.log or the`,
      `container log says the X server died. Container exit ${status}.`,
    ];
    const last = tail(containerLog, 20);
    if (last) lines.push('', 'Last 20 lines of the container log:', '', '```', last, '```');
    return done(EXIT_FAIL, lines);
  }

  // 3. the suite reported, so no path below can retry and a failed scenario never sees a 75.
  let summary;
  try {
    summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  } catch (error) {
    return done(EXIT_FAIL, [`**summary.json is not valid JSON.** ${error.message}`]);
  }

  const total = summary.total ?? 0;
  const passed = summary.passed ?? 0;
  const failed = summary.failed ?? 0;
  const skipped = summary.skipped ?? 0;
  const flaky = summary.flaky ?? 0;
  const exitReason = summary.exitReason ?? 'unknown';

  const htmlMs = mtime(htmlPath);
  let payload = null;
  let payloadError = null;
  if (htmlMs !== null) {
    try {
      payload = readPayload(readFileSync(htmlPath, 'utf8'));
      if (!payload) payloadError = 'report.html carries no pickle-report payload.';
    } catch (error) {
      payloadError = `report.html payload is not readable: ${error.message}`;
    }
  }

  const notices = [];
  const detail = [];
  let code = 0;
  let verdict;

  if (htmlMs === null) {
    // 4. report.html is the last file WriteReports emits, so losing it alone means it threw.
    code = EXIT_FAIL;
    verdict = `**The report write failed partway.** \`${dir}\` has summary.json but no report.html.`;
  } else if (total === 0) {
    // 5. an unfiltered empty run throws from 1c18a3a on, so this is a filter that matched
    // nothing, or a consumer pinned to an older Pickle.
    code = EXIT_FAIL;
    verdict = `**Zero scenarios ran** (exitReason \`${exitReason}\`).`;
    const help = filterHelp(playerLog);
    if (help) detail.push('', '```', help, '```');
  } else if (failed > 0) {
    code = EXIT_FAIL;
    verdict = `**${failed} of ${total} scenarios failed.**`;
  } else if (exitReason !== 'passed') {
    // 7. catches failed, infrastructure-error, watchdog-timeout and a killed run's in-progress.
    code = EXIT_FAIL;
    verdict = `**The run did not finish** (exitReason \`${exitReason}\`).`;
  } else {
    verdict = `**All ${total} scenario${total === 1 ? '' : 's'} passed.**`;
    // 8. xvfb-run tears the display down after the game exits and takes the exit code with it.
    if (status !== 0) {
      notices.push(
        `::notice title=Pickle container exit ${status}::every scenario passed; ` +
          'this exit code is xvfb-run teardown, not a failed run',
      );
    }
  }

  const counts = `${passed} passed, ${failed} failed, ${skipped} skipped, exitReason \`${exitReason}\`.`;
  const lines = [verdict, '', PARTIAL_REASONS.has(exitReason) ? `${counts} **The counts are partial.**` : counts];

  // 9. counted, never gated on: a scenario that failed then passed on retry is a pass.
  if (flaky > 0) lines.push('', `${flaky} scenario(s) failed at least once before passing.`);
  lines.push(...detail);

  const failures = payload ? failuresFrom(payload) : [];
  if (payloadError && failed > 0) lines.push('', `No failure table: ${payloadError}`);

  // WriteReports rewrites every file on an interval, so a container killed between writes leaves
  // an html payload older than summary.json and short of the last failures.
  if (failures.length > 0 && htmlMs < summaryMs) {
    lines.push('', 'report.html is older than summary.json, so this table can be missing the last failures.');
  }

  if (failures.length > 0) {
    lines.push('', '| Feature | Mod | Scenario | Failing step | Message |', '|---|---|---|---|---|');
    for (const f of failures) {
      lines.push(
        `| ${cell(f.feature)} | ${cell(f.mod)} | ${cell(f.scenario)} | ${cell(f.step)} | ${cell(f.message, MESSAGE_CHARS)} |`,
      );
    }
  }

  if (code !== 0) lines.push('', `Report: \`${dir}\``);
  return done(code, lines, notices);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] || process.env.REPORT_DIR;
  const stamp = process.argv[4] || process.env.STAMP_FILE;
  if (!dir || !stamp) {
    process.stderr.write('usage: verdict.mjs <report-dir> [status] [stamp] [container-log]\n');
    process.exit(EXIT_FAIL);
  }

  const { code, markdown, notices } = decide({
    dir,
    status: Number(process.argv[3] || process.env.RUN_STATUS || 0),
    stamp,
    containerLog: process.argv[5] || process.env.CONTAINER_LOG || join(dir, 'container.log'),
  });

  for (const notice of notices) process.stdout.write(`${notice}\n`);
  process.stdout.write(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  process.exit(code);
}
