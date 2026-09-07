import { test } from 'node:test';
import assert from 'node:assert/strict';

// semantic-release-steam is an optional peer. A top-level import of it in workshop-bump.mjs
// made the whole package unloadable for any repo that does not publish to Steam.
test('the package imports without the optional steam peer installed', async () => {
  const mod = await import('../index.mjs');

  assert.equal(typeof mod.writeStamp, 'function');
  assert.equal(typeof mod.bumpWorkshop, 'function');
  assert.equal(typeof mod.missingFromReleaseZip, 'function');
});

test('bumpWorkshop rejects a missing workshop id before touching steam', async () => {
  const { bumpWorkshop } = await import('../index.mjs');

  await assert.rejects(() => bumpWorkshop({ workshopId: '' }), /no workshop id configured/);
});
