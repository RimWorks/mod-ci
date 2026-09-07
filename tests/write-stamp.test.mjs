import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeStamp, shippedPackages } from '../lib/write-stamp.mjs';

test('a missing solution is an error rather than a silent wrong default', async () => {
  await assert.rejects(() => shippedPackages(), /needs a solution path/);
});

test('an unreadable solution yields no packages instead of throwing', async () => {
  assert.deepEqual(await shippedPackages('/nope/does-not-exist.sln'), []);
});

test('writes the stamp under About and returns it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stamp-'));
  const body = await writeStamp({ modPath: root });

  assert.match(body, /^verified \d{4}-\d{2}-\d{2}T/);
  assert.equal(await readFile(join(root, 'About', 'PublishStamp.txt'), 'utf8'), body);
});

test('records the commit and test count the workflow supplies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stamp-'));
  process.env.VERIFIED_COMMIT = 'abcdef1234567890';
  process.env.VERIFIED_TESTS = '1109';
  try {
    const body = await writeStamp({ modPath: root });
    assert.match(body, /commit {3}abcdef1/);
    assert.match(body, /tests {4}1109 passed/);
  } finally {
    delete process.env.VERIFIED_COMMIT;
    delete process.env.VERIFIED_TESTS;
  }
});
