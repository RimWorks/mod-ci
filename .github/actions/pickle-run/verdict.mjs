#!/usr/bin/env node
// Decides pass, fail or retry after a Pickle container run. Everything it reads is in
// summary.json, which Pickle writes last, so a fresh one means the whole report dir is.
// argv first, then env: <report-dir> REPORT_DIR, <status> RUN_STATUS, <stamp> STAMP_FILE,
// <container-log> CONTAINER_LOG. Exits 0 pass, 75 retry, 1 the suite failed, 2 no report to read.

import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXIT_FAIL = 1;
// a comparison leg absorbs EXIT_FAIL and nothing else, so "no report to read" needs its own code
const EXIT_NO_REPORT = 2;
const EXIT_RETRY = 75;

// Xlib writes TWO spaces after XIO:. a one-space pattern matches nothing and kills every retry
const X_SERVER_DIED = /XIO:\s+fatal IO error|Desktop is 0 x 0/;

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

function cell(text, limit = 0) {
  let value = String(text ?? '');
  if (limit > 0 && value.length > limit) value = `${value.slice(0, limit)} ...`;
  return value
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/\r?\n/g, '<br>');
}

function tail(path, count) {
  const text = read(path);
  if (!text) return null;
  return text.split('\n').filter(Boolean).slice(-count).join('\n');
}

// an unreadable log greps like a clean one, so a blind grep would read as "no X death"
function xServerScan(entries) {
  let died = false;
  const unreadable = [];
  const stale = [];
  for (const { path, since = null } of entries) {
    const ms = since === null ? null : mtime(path);
    // a previous attempt's X death says nothing about this one, and stale is not unreadable
    if (ms !== null && ms <= since) {
      stale.push(String(path));
      continue;
    }
    const text = read(path);
    if (text === null || text.trim() === '') unreadable.push(String(path));
    else if (X_SERVER_DIED.test(text)) died = true;
  }
  return { died, unreadable, stale };
}

// ScenarioFilter.DescribeNoMatch only ever reaches the log, so it gets lifted out here
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

function failuresFrom(scenarios) {
  return (scenarios ?? [])
    .filter((s) => s.outcome === 'Failed')
    .map((s) => ({
      feature: s.feature || '(unnamed feature)',
      scenario: s.name,
      step: s.failingStep || '(no step failed - a hook or the run itself did)',
      message: s.failureMessage || '(no message)',
    }));
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
// GUARDS run first and are the only place a retry comes from, so a failed scenario cannot reach one
const GUARDS = [
  // 1. the stamp is the only way to tell this run's report from a previous attempt's
  { n: 1, name: 'no-stamp', run: ({ stamp, stampMs }) => stampMs !== null ? null
      : done(EXIT_NO_REPORT, [`**No stamp file at \`${stamp}\`.** The caller has to \`mktemp\` one before \`docker run\`.`]) },

  // 2. the last point a retry is possible
  { n: 2, name: 'never-reported', run: (ctx) => ctx.summaryMs !== null ? null : judgeNoReport(ctx) },

  // 3. the suite reported, so nothing below can retry
  { n: 3, name: 'unreadable-summary', run: (ctx) => ctx.summary !== undefined ? null
      : done(EXIT_NO_REPORT, [`**summary.json is not valid JSON.** ${ctx.summaryError.message}`]) },
];

const VERDICTS = [
  // 4. an unfiltered empty run throws from 1c18a3a on, so this is a filter that matched nothing
  { n: 4, name: 'zero-scenarios', run: ({ total, exitReason, playerLog }) => {
      if (total !== 0) return null;
      const help = filterHelp(playerLog);
      return {
        code: EXIT_FAIL,
        verdict: `**Zero scenarios ran** (exitReason \`${exitReason}\`).`,
        detail: help ? ['', '```', help, '```'] : [],
      };
    } },

  // 5. the table further down is the answer a reader came for, not this line
  { n: 5, name: 'scenarios-failed', run: ({ failed, total }) => failed === 0 ? null
      : { code: EXIT_FAIL, verdict: `**${failed} of ${total} scenarios failed.**` } },

  // 6. catches failed, infrastructure-error, watchdog-timeout and a killed run's in-progress
  { n: 6, name: 'did-not-finish', run: ({ exitReason }) => exitReason === 'passed' ? null
      : { code: EXIT_FAIL, verdict: `**The run did not finish** (exitReason \`${exitReason}\`).` } },

  // 7. xvfb-run tears the display down after the game exits and takes the exit code with it
  { n: 7, name: 'passed', run: ({ total, status }) => ({
      code: 0,
      verdict: `**All ${total} scenario${total === 1 ? '' : 's'} passed.**`,
      notices: status === 0 ? [] : [
        `::notice title=Pickle container exit ${status}::every scenario passed; ` +
          'this exit code is xvfb-run teardown, not a failed run',
      ],
    }) },
];

// The no-summary branch: an X death retries, anything else reports what it could and could not read.
function judgeNoReport({ dir, status, containerLog, playerLog, stampMs, fresh }) {
  // the runners truncate the container log per attempt, so only Player.log can be a leftover
  const scan = xServerScan([{ path: playerLog, since: stampMs }, { path: containerLog }]);
  if (scan.died) {
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
  const notices = [];

  if (scan.stale.length > 0) {
    lines.push('', `\`${scan.stale.join('`, `')}\` predates the stamp, so it is a previous attempt's file and was not read.`);
  }

  // a caller passing a path run-suite.sh did not write to greps an empty file
  if (containerLog == null || scan.unreadable.includes(String(containerLog))) {
    const where = containerLog == null ? '(no path given)' : `\`${containerLog}\``;
    lines.push(
      '',
      `**No container log to grep at ${where}.** The X-server check ran blind, so a dead X`,
      'server would read as a real failure and never retry. Pass the path run-suite.sh wrote to.',
    );
    notices.push(
      '::error title=Pickle container log missing::' +
        `nothing to read at ${containerLog ?? '(no path given)'}; the X-server retry check was blind`,
    );
  }

  // unanchored: CI writes the line bare, a local RimLogging wraps it in a colour tag
  const bootLog = fresh(playerLog) === null ? null : read(playerLog);
  if (bootLog != null && !bootLog.includes('pickle: loaded')) {
    lines.push(
      '',
      '**Pickle never loaded.** Player.log carries no `pickle: loaded`, which PickleMod writes',
      'from its constructor, so the mod was never built. Check ModsConfig.xml reached the game:',
      'on linux the config dir mounts as the Config folder, on windows at /home/app/savedata/Config.',
    );
  }

  const last = tail(containerLog, 20);
  if (last) lines.push('', 'Last 20 lines of the container log:', '', '```', last, '```');
  return done(EXIT_NO_REPORT, lines, notices);
}

export function decide({ dir, status = 0, stamp, containerLog } = {}) {
  const stampMs = mtime(stamp);
  // every report file goes through here: older than the stamp is a leftover, so it reads as absent
  const fresh = (path) => {
    const ms = mtime(path);
    return ms !== null && ms > stampMs ? ms : null;
  };

  const summaryPath = join(dir, 'summary.json');
  const ctx = { dir, status, stamp, stampMs, containerLog, fresh, playerLog: join(dir, 'Player.log') };
  ctx.summaryMs = stampMs === null ? null : fresh(summaryPath);

  if (ctx.summaryMs !== null) {
    try {
      ctx.summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    } catch (error) {
      ctx.summaryError = error;
    }
  }

  for (const guard of GUARDS) {
    const out = guard.run(ctx);
    if (out) return out;
  }

  const summary = ctx.summary;
  Object.assign(ctx, {
    total: summary.total ?? 0,
    passed: summary.passed ?? 0,
    failed: summary.failed ?? 0,
    skipped: summary.skipped ?? 0,
    flaky: summary.flaky ?? 0,
    exitReason: summary.exitReason ?? 'unknown',
  });

  const answer = VERDICTS.map((check) => check.run(ctx)).find(Boolean);
  const { code, verdict, detail = [], notices = [] } = answer;

  const { total, passed, failed, skipped, flaky, exitReason } = ctx;
  const counts = `${passed} passed, ${failed} failed, ${skipped} skipped, exitReason \`${exitReason}\`.`;
  const lines = [verdict, '', PARTIAL_REASONS.has(exitReason) ? `${counts} **The counts are partial.**` : counts];

  // 8. counted, never gated on: a scenario that failed then passed on retry is a pass
  if (flaky > 0) lines.push('', `${flaky} scenario(s) failed at least once before passing.`);
  lines.push(...detail);

  const failures = failuresFrom(summary.scenarios);
  if (failures.length > 0) {
    lines.push('', '| Feature | Scenario | Failing step | Message |', '|---|---|---|---|');
    for (const f of failures) {
      lines.push(
        `| ${cell(f.feature)} | ${cell(f.scenario)} | ${cell(f.step)} | ${cell(f.message, MESSAGE_CHARS)} |`,
      );
    }
  }

  if (code !== 0) lines.push('', `Report: \`${dir}\``);
  return done(code, lines, notices);
}

export const CHECK_ORDER = [...GUARDS, ...VERDICTS].map((c) => `${c.n}:${c.name}`);

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] || process.env.REPORT_DIR;
  const stamp = process.argv[4] || process.env.STAMP_FILE;
  // no default: a guessed path reads empty, and an empty grep fails every X death instead of retrying
  const containerLog = process.argv[5] || process.env.CONTAINER_LOG;
  if (!dir || !stamp || !containerLog) {
    process.stderr.write('usage: verdict.mjs <report-dir> <status> <stamp> <container-log>\n');
    process.exit(EXIT_FAIL);
  }

  const { code, markdown, notices } = decide({
    dir,
    status: Number(process.argv[3] || process.env.RUN_STATUS || 0),
    stamp,
    containerLog,
  });

  for (const notice of notices) process.stdout.write(`${notice}\n`);
  process.stdout.write(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  process.exit(code);
}
