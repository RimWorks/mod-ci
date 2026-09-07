#!/usr/bin/env node
import { missingFromReleaseZip } from '../lib/ship-list.mjs';

const root = process.argv[2] ?? process.cwd();

let result;
try {
  result = await missingFromReleaseZip(root);
} catch (err) {
  console.error(`verify-ship-list: ${err.message}`);
  process.exit(2);
}

const { shipped, missing } = result;

if (shipped === null) {
  console.log('no "cp -r ... dist/" step in release.config.mjs, nothing to check');
  process.exit(0);
}

if (missing.length > 0) {
  console.error(`release.config.mjs does not copy: ${missing.join(', ')}`);
  console.error('Steam rsyncs the whole mod dir so it ships these, the GitHub zip does not.');
  process.exit(1);
}

console.log(`release zip ships every mod content directory (${shipped.join(' ')})`);
