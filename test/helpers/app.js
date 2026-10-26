// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a fake controller and a virtual
// clock. The monotonic clock moves 1 µs per read of it, so that a decision
// reading the clock twice is caught (lesson of the lot 15).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { TouchlineApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { buildDevice } from '../../src/devices.js';
import { memoryStore } from '../../src/store.js';
import { parseDevice } from '../../src/touchline/model.js';
import { DEVICE, fakeController } from './fakeController.js';
import { createFakeClock } from './fakeTimers.js';

export const SELECTOR = 'roth';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
export const ADDRESS = '192.168.1.254';
export const CONFIG = { host: ADDRESS };
/** The external ids of the default device (owner 100, id 1). */
export const DEVICE_ID = `ext:${SELECTOR}:touchline:100-1`;
export const F = (role, key = '100-1') => `ext:${SELECTOR}:touchline:${key}:${role}`;

/** The device of a room thermostat as the user created it from the Discovery list. */
export function created(over = {}, { index = 0, language = 'fr' } = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const raw = DEVICE(over);
  const values = new Map(Object.entries(raw).map(([k, v]) => [`G${index}.${k}`, v]));
  const device = parseDevice(values, index);
  return buildDevice(gladys, { owner: device.owner, id: device.id }, { device, language });
}

/** Lets the pending promises settle (no timer involved). */
export const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

export async function setup({
  devices: known = [],
  store,
  now = NOW,
  world = fakeController(),
  config = CONFIG,
  wall = { offset: 0 },
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices: known });
  await gladys.connect();
  const { clock, timers, advance } = createFakeClock(now);
  let drift = 0;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const kept = store ?? memoryStore();
  const app = new TouchlineApp({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    transport: world.transport,
    // The wall clock may be set apart from the monotonic one (`wall.offset`).
    now: () => clock.now + wall.offset,
    // A real monotonic clock moves between two reads of it: 1 µs per call.
    monotonic: () => clock.now + (drift += 0.001),
    timers,
    store: kept,
  });
  // The exact wiring of the container; Gladys is already connected, so the
  // first start goes through app.connected() as in production.
  registerHandlers(gladys, app, { error: log });
  const start = async (cfg = config) => {
    await app.connected(cfg);
    await settle();
  };
  const wait = async (ms) => {
    await advance(ms);
    await settle();
  };
  return { app, gladys, clock, store: kept, world, start, wait, advance, lines };
}
