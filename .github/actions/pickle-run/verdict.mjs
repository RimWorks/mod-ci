#!/usr/bin/env node
// Decides pass, fail or retry after a Pickle container run, and writes the GitHub step summary.
// Counts come from summary.json; step text and failure messages come from the payload inside
// report.html, the only report file carrying either.
// argv first, then env: <report-dir> REPORT_DIR, <status> RUN_STATUS, <stamp> STAMP_FILE,
// <container-log> CONTAINER_LOG. Exits 0 pass, 75 retry, 1 the suite failed, 2 no report to read.

import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXIT_FAIL = 1;
// a comparison leg absorbs EXIT_FAIL and nothing else, so "no report to read" needs its own code
const EXIT_NO_REPORT = 2;
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

// A log we could not read greps the same as a clean one, and a blind grep reads as "no X death"
// and burns the only retry there is. So report what was unreadable alongside the answer.
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
// The nine checks, in order. GUARDS run first and are the only place a retry can come from, so a
// failed scenario can never reach one. VERDICTS then pick exactly one answer from a report we read.
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
  // 4. report.html is the last file WriteReports emits, so losing it alone means it threw
  { n: 4, name: 'report-write-threw', run: ({ htmlMs, dir }) => htmlMs !== null ? null
      : { code: EXIT_FAIL, verdict: `**The report write failed partway.** \`${dir}\` has summary.json but no report.html newer than the stamp.` } },

  // 5. an unfiltered empty run throws from 1c18a3a on, so this is a filter that matched nothing
  { n: 5, name: 'zero-scenarios', run: ({ total, exitReason, playerLog }) => {
      if (total !== 0) return null;
      const help = filterHelp(playerLog);
      return {
        code: EXIT_FAIL,
        verdict: `**Zero scenarios ran** (exitReason \`${exitReason}\`).`,
        detail: help ? ['', '```', help, '```'] : [],
      };
    } },

  // 6. the table further down is the answer a reader came for, not this line
  { n: 6, name: 'scenarios-failed', run: ({ failed, total }) => failed === 0 ? null
      : { code: EXIT_FAIL, verdict: `**${failed} of ${total} scenarios failed.**` } },

  // 7. catches failed, infrastructure-error, watchdog-timeout and a killed run's in-progress
  { n: 7, name: 'did-not-finish', run: ({ exitReason }) => exitReason === 'passed' ? null
      : { code: EXIT_FAIL, verdict: `**The run did not finish** (exitReason \`${exitReason}\`).` } },

  // 8. xvfb-run tears the display down after the game exits and takes the exit code with it
  { n: 8, name: 'passed', run: ({ total, status }) => ({
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

  // run-suite.sh writes the container's stdout to $RUNNER_TEMP/container.log, so a caller that
  // passes a different path greps a file nothing wrote
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

  // unanchored on purpose: CI writes the line bare and a locally configured RimLogging wraps it in
  // a colour tag, so anchoring would claim Pickle never loaded when it did
  const bootLog = fresh(playerLog) === null ? null : read(playerLog);
  if (bootLog != null && !bootLog.includes('pickle: loaded')) {
    lines.push(
      '',
      '**Pickle never loaded.** Player.log carries no `pickle: loaded`, which PickleMod writes',
      'from its constructor, so the mod was never built. Check ModsConfig.xml reached the game:',
      'on linux the config dir mounts as the Config folder, on windows it mounts at /config/Config.',
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
  const htmlPath = join(dir, 'report.html');
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
    htmlMs: fresh(htmlPath),
  });

  let payload = null;
  let payloadError = null;
  if (ctx.htmlMs !== null) {
    try {
      payload = readPayload(readFileSync(htmlPath, 'utf8'));
      if (!payload) payloadError = 'report.html carries no pickle-report payload.';
    } catch (error) {
      payloadError = `report.html payload is not readable: ${error.message}`;
    }
  }

  const answer = VERDICTS.map((check) => check.run(ctx)).find(Boolean);
  const { code, verdict, detail = [], notices = [] } = answer;

  const { total, passed, failed, skipped, flaky, exitReason, htmlMs } = ctx;
  const counts = `${passed} passed, ${failed} failed, ${skipped} skipped, exitReason \`${exitReason}\`.`;
  const lines = [verdict, '', PARTIAL_REASONS.has(exitReason) ? `${counts} **The counts are partial.**` : counts];

  // 9. counted, never gated on: a scenario that failed then passed on retry is a pass
  if (flaky > 0) lines.push('', `${flaky} scenario(s) failed at least once before passing.`);
  lines.push(...detail);

  const failures = payload ? failuresFrom(payload) : [];
  // summary.json is the verdict, so an unreadable payload never gates. it still gets said out loud
  // on a green run: a killed container leaves a half-written report.html and nothing else shows it
  if (payloadError) {
    lines.push('', `No failure table: ${payloadError}`);
    // %0A because a JSON.parse message can carry the newline it choked on, which would cut the
    // annotation short and spill the rest as plain stdout
    notices.push(`::warning title=Pickle report.html unreadable::${payloadError.replace(/\r?\n/g, '%0A')}`);
  }

  // WriteReports rewrites every file on an interval, so a container killed between writes leaves an
  // html payload older than summary.json and short of the last failures
  if (failures.length > 0 && htmlMs < ctx.summaryMs) {
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
