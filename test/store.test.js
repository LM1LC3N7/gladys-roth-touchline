import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TIMINGS } from '../src/constants.js';
import { fileStore, normalizeMemory } from '../src/store.js';

const KEY = 'a'.repeat(32);

test('normalizeMemory: repaired, capped from now, nothing kept for another controller', () => {
  const now = 1_000_000_000;
  assert.deepEqual(normalizeMemory(null, now), {
    lastAttemptAt: null,
    key: '',
    pause: null,
    lastWriteAt: null,
  });
  const kept = normalizeMemory(
    {
      lastAttemptAt: now + 5_000,
      key: KEY,
      pause: { until: now + 10 * TIMINGS.pauseMax, failures: 99 },
      lastWriteAt: now - 10,
    },
    now,
  );
  assert.equal(kept.lastAttemptAt, now, 'never in the future');
  assert.equal(kept.pause.until, now + TIMINGS.pauseMax, 'a pause is capped');
  assert.equal(kept.pause.failures, 10);
  assert.equal(kept.lastWriteAt, now - 10);
  const foreign = normalizeMemory(
    { key: 'not-a-key', pause: { until: now + 10 }, lastWriteAt: 1 },
    now,
  );
  assert.equal(foreign.key, '');
  assert.equal(foreign.pause, null);
  assert.equal(foreign.lastWriteAt, null);
  assert.equal(normalizeMemory({ lastAttemptAt: 'x', key: KEY, pause: 'x' }, now).pause, null);
});

test('fileStore: a fresh install is null, a file is written 0600 through a temporary file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roth-'));
  const store = fileStore(join(dir, 'state.json'));
  assert.equal(await store.load(), null);
  await Promise.all([store.save({ a: 1 }), store.save({ a: 2 })]);
  assert.deepEqual(await store.load(), { a: 2 });
  assert.equal(statSync(join(dir, 'state.json')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), '{"a":2}');
  const broken = fileStore(join(dir, 'broken.json'));
  await broken.save('x'.repeat(70 * 1024));
  await assert.rejects(broken.load(), /too large/);
});
