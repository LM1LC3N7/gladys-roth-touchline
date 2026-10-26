// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and a
// real local HTTP server playing the controller: the reads really start, at
// 0, the interval and twice the interval, with a bounded number of timers.
// The time is sped up 20 times (60 s of the interval are 3 s) but it is the
// real clock: it moves between any two reads of it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { TouchlineApp } from '../src/app.js';
import { POLL_INTERVAL } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { DEVICE, answerFor } from './helpers/fakeController.js';

const SPEED = 20;
const INTERVAL = POLL_INTERVAL.default * 1000;

test('real clock: reads at 0, the interval and twice the interval; timers bounded', async () => {
  const devices = [DEVICE()];
  const reads = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const names = [...body.matchAll(/<n>([^<]+)<\/n>/g)].map((m) => m[1]);
      if (names.includes('totalNumberOfDevices')) reads.push(performance.now() * SPEED);
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(answerFor(names, devices));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  let timersSet = 0;
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      return setTimeout(fn, Math.max(0, ms) / SPEED);
    },
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, Math.max(1, ms) / SPEED),
    clearInterval: (id) => clearInterval(id),
  };
  const gladys = createFakeGladys({ selector: 'roth', config: {} });
  await gladys.connect();
  const quiet = () => {};
  const app = new TouchlineApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: () => Date.now() * SPEED,
    monotonic: () => performance.now() * SPEED,
    timers,
    store: memoryStore(),
  });
  const started = performance.now() * SPEED;
  try {
    await app.start({ host: `127.0.0.1:${port}` });
    const deadline = started + INTERVAL;
    while (reads.length === 0 && performance.now() * SPEED < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const until = (reads[0] ?? started) + 2.5 * INTERVAL;
    while (performance.now() * SPEED < until) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    app.stop();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const at = reads.map((t) => Math.round(t - started));
  assert.equal(reads.length, 3, `reads at ${at}`);
  assert.ok(reads[0] - started < INTERVAL / 2, `the first read at once: ${at}`);
  for (let i = 1; i < reads.length; i += 1) {
    const gap = reads[i] - reads[i - 1];
    // Seen by the server: the latency of the request before (times SPEED) may shorten the gap seen here.
    assert.ok(gap >= 0.9 * INTERVAL, `never sooner than the interval: ${at}`);
    assert.ok(gap < 1.5 * INTERVAL, `on time: ${at}`);
  }
  assert.ok(timersSet <= 10, `${timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});
