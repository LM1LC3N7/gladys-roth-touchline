// -----------------------------------------------------------------------------
// End to end: the app against the SDK's fake Gladys, the fake controller and
// a virtual clock whose monotonic reads always move.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { TouchlineApp } from '../src/app.js';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { memoryStore } from '../src/store.js';
import { DEVICE, fakeController } from './helpers/fakeController.js';
import { CONFIG, DEVICE_ID, F, MINUTE, SECOND, created, settle, setup } from './helpers/app.js';

const reads = (world) => world.requests.filter((r) => r.method === 'POST');
const writes = (world) => world.requests.filter((r) => r.method === 'GET');
const counts = (world) =>
  reads(world).filter((r) => String(r.body).includes('totalNumberOfDevices'));

test('start: a read at once, the devices discovered, the status connected, nothing written to /data in clear', async () => {
  const { app, gladys, start, store, world } = await setup();
  await start();
  assert.equal(counts(world).length, 1);
  assert.equal(reads(world).length, 2, 'the count, then G0');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.fr, /Connecté : 1\/1 appareil lu/);
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.equal(gladys.fake.discoveredDevices[0].external_id, DEVICE_ID);
  assert.equal(gladys.fake.states.length, 0, 'no state before the device is created');
  const json = JSON.stringify(store.data);
  assert.doesNotMatch(json, /192\.168/);
  assert.equal(store.data.lastAttemptAt, app.now() - 0);
  app.stop();
});

test('pace: never two reads within the interval, whatever asks; the clock read once per decision', async () => {
  const { app, gladys, start, wait, world, clock } = await setup();
  await start();
  assert.equal(counts(world).length, 1);
  await gladys.fake.scanRequest();
  await gladys.fake.configUpdated({ ...CONFIG, language: 'en' });
  await app.testConnection();
  await app.connected(CONFIG);
  await wait(30 * SECOND);
  assert.equal(counts(world).length, 1, 'nothing before the interval');
  await wait(30 * SECOND);
  assert.equal(counts(world).length, 2, 'the second read at the interval');
  await wait(10 * MINUTE);
  assert.equal(counts(world).length, 12, 'one read per interval');
  const at = counts(world).map((r) => Math.round(r.at - clock.now));
  for (let i = 1; i < at.length; i += 1) {
    assert.ok(at[i] - at[i - 1] >= MINUTE - 1, `gap ${at[i] - at[i - 1]}`);
  }
  app.stop();
});

test('restart: the time of the last attempt in /data holds the first read', async () => {
  const first = await setup();
  await first.start();
  first.app.stop();
  const second = await setup({ store: first.store, now: first.clock.now + 20 * SECOND });
  await second.start();
  assert.equal(counts(second.world).length, 0, 'read 20 s ago: not yet');
  await second.wait(39 * SECOND);
  assert.equal(counts(second.world).length, 0);
  await second.wait(2 * SECOND);
  assert.equal(counts(second.world).length, 1);
  second.app.stop();
});

test('states go to the created device only, and at once when it is created', async () => {
  const device = created();
  const { app, gladys, start, wait, world } = await setup({ devices: [device] });
  await start();
  await wait(SECOND);
  assert.equal(gladys.fake.lastState(F('temperature')), 21.5);
  assert.equal(gladys.fake.lastState(F('target-temperature')), 22);
  assert.equal(gladys.fake.lastState(F('mode')), 'normal');
  assert.equal(gladys.fake.lastState(F('program')), 'none');
  assert.equal(gladys.fake.transports.at(-1).transport, 'local');
  world.devices[0].RaumTemp = '2000';
  world.devices[0].OPMode = '1';
  await wait(MINUTE);
  assert.equal(gladys.fake.lastState(F('temperature')), 20);
  assert.equal(gladys.fake.lastState(F('mode')), 'night');
  // A value unreadable publishes nothing (the last value stays).
  world.devices[0].RaumTemp = 'NA';
  world.devices[0].OPMode = '9';
  const before = gladys.fake.states.length;
  await wait(MINUTE);
  assert.equal(gladys.fake.lastState(F('temperature')), 20);
  assert.equal(gladys.fake.lastState(F('mode')), 'night');
  assert.equal(gladys.fake.states.length, before, 'nothing new published');
  app.stop();
});

test('a device created later gets its last values at once', async () => {
  const { app, gladys, start, world } = await setup();
  await start();
  assert.equal(gladys.fake.states.length, 0);
  await gladys.fake.deviceCreated(created());
  assert.equal(gladys.fake.lastState(F('temperature')), 21.5);
  assert.equal(reads(world).length, 2, 'no read for it');
  app.stop();
});

test('identity: the values of a round go to the device of the ids read, never by position', async () => {
  const living = created();
  const bedroom = created({ name: 'Bedroom', kurzID: '2', RaumTemp: '1800' }, { index: 1 });
  const world = fakeController({
    devices: [DEVICE(), DEVICE({ name: 'Bedroom', kurzID: '2', RaumTemp: '1800' })],
  });
  const { app, gladys, start, wait } = await setup({ devices: [living, bedroom], world });
  await start();
  await wait(SECOND);
  assert.equal(gladys.fake.lastState(F('temperature')), 21.5);
  assert.equal(gladys.fake.lastState(F('temperature', '100-2')), 18);
  // The living room is removed from the controller: the bedroom moves to G0.
  world.devices.splice(0, 1);
  await wait(MINUTE);
  assert.equal(gladys.fake.lastState(F('temperature', '100-2')), 18);
  assert.equal(
    gladys.fake.lastState(F('temperature')),
    21.5,
    'the living room keeps its last value',
  );
  const badges = Object.fromEntries(gladys.fake.transports.map((t) => [t.device_external_id, t]));
  assert.equal(badges[DEVICE_ID].transport, 'unreachable');
  assert.equal(badges[DEVICE_ID].degraded, true);
  assert.equal(badges[`ext:roth:touchline:100-2`].transport, 'local');
  assert.equal(
    gladys.fake.discoveredDevices.length,
    2,
    'a created device is never dropped from Discovery',
  );
  app.stop();
});

test('identity: two devices with the same ids in one round are not trusted', async () => {
  const world = fakeController({ devices: [DEVICE(), DEVICE({ RaumTemp: '1000' })] });
  const { app, gladys, start, wait } = await setup({ devices: [created()], world });
  await start();
  await wait(SECOND);
  assert.equal(gladys.fake.lastState(F('temperature')), undefined);
  assert.match(gladys.fake.connectionStatus.message.en, /G0 \(same ids as another device\), G1/);
  app.stop();
});

test('a device that does not answer leaves only that device unread; the round is bounded', async () => {
  const world = fakeController({ devices: [DEVICE(), DEVICE({ kurzID: '2' })] });
  const { app, gladys, start, wait } = await setup({ devices: [created()], world });
  // The count answers, G0 fails this round, G1 answers.
  world.queue.push(() => undefined);
  world.failNetwork();
  await start();
  await wait(SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /Connected: 1\/2 devices read\. Not read: G0 \(the controller cannot be reached/,
  );
  assert.equal(gladys.fake.lastState(F('temperature')), undefined);
  await wait(MINUTE);
  assert.equal(gladys.fake.lastState(F('temperature')), 21.5, 'read on the next round');
  assert.match(gladys.fake.connectionStatus.message.en, /2\/2/);
  app.stop();
});

test('the count failing: a pause never under the interval, 1, 2, 5 min…, kept in /data, the badge unreachable', async () => {
  const { app, gladys, start, wait, world, store, clock } = await setup({ devices: [created()] });
  world.failNetwork();
  await start();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.fr, /injoignable.*Nouvel essai dans 1 min/);
  assert.equal(gladys.fake.transports.at(-1).transport, 'unreachable');
  assert.ok(store.data.pause.until > clock.now);
  world.failNetwork();
  await wait(MINUTE);
  assert.equal(counts(world).length, 2);
  assert.match(gladys.fake.connectionStatus.message.en, /2 min/);
  world.failNetwork();
  await wait(MINUTE);
  assert.equal(counts(world).length, 2, 'not before the pause');
  await wait(MINUTE);
  assert.equal(counts(world).length, 3);
  assert.match(gladys.fake.connectionStatus.message.en, /5 min/);
  await wait(5 * MINUTE);
  assert.equal(counts(world).length, 4);
  assert.equal(gladys.fake.connectionStatus.connected, true, 'the pause lifted by a read');
  assert.equal(store.data.pause, null);
  assert.equal(gladys.fake.transports.at(-1).transport, 'local');
  // A restart during a pause keeps it (capped).
  world.failNetwork();
  await wait(MINUTE);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  app.stop();
  const again = await setup({ store, devices: [created()], now: clock.now + 10 * SECOND });
  await again.start();
  assert.equal(counts(again.world).length, 0, 'the pause holds across a restart');
  assert.match(again.gladys.fake.connectionStatus.message.en, /New try in/);
  await again.wait(MINUTE);
  assert.equal(counts(again.world).length, 1);
  again.app.stop();
});

test('an internal error never leaves the integration without a timer', async () => {
  const { app, start, wait, world, lines } = await setup();
  await start();
  world.queue.push(() => {
    throw new TypeError('bug');
  });
  await wait(MINUTE);
  assert.ok(lines.some((l) => /internal error; next try in 60 s/.test(l)));
  assert.equal(counts(world).length, 2);
  await wait(MINUTE);
  assert.equal(counts(world).length, 3, 'the next read came');
  // A bug inside the app itself (not the transport): a pause, the next read scheduled.
  app.saveAttempt = () => {
    throw new TypeError('bug');
  };
  await wait(MINUTE);
  assert.ok(lines.some((l) => /unexpected error \(TypeError: bug\)/.test(l)));
  assert.equal(counts(world).length, 3);
  delete app.saveAttempt;
  await wait(MINUTE);
  assert.equal(counts(world).length, 4, 'still alive');
  app.stop();
});

test('configuration: a new address restarts and clears the pause; options apply at once; a bad address is told', async () => {
  const { app, gladys, start, wait, world } = await setup();
  world.failNetwork();
  await start();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  await gladys.fake.configUpdated({ host: '192.168.1.253' });
  await settle();
  assert.equal(counts(world).length, 1, 'a new address never reads sooner than the interval');
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /Reading the controller/,
    'the pause of the old address is gone',
  );
  await wait(MINUTE);
  assert.equal(counts(world).length, 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(world.requests.at(-1).hostname, '192.168.1.253');
  await gladys.fake.configUpdated({
    host: '192.168.1.253',
    allow_setpoints: true,
    poll_interval: 30,
  });
  assert.equal(app.config.allowSetpoints, true);
  await wait(30 * SECOND);
  assert.equal(counts(world).length, 3, 'the new interval applies to the next read');
  await gladys.fake.configUpdated({ host: 'https://192.168.1.253' });
  assert.match(gladys.fake.connectionStatus.message.fr, /sans « https:\/\/ »/);
  await gladys.fake.configUpdated({ host: '' });
  assert.match(gladys.fake.connectionStatus.message.en, /Enter the IP address/);
  app.stop();
});

test('reconnection to Gladys: the status, the list and the badges again; nothing read, nothing cleared', async () => {
  const { app, gladys, start, world } = await setup({ devices: [created()] });
  world.failNetwork();
  await start();
  const statuses = gladys.fake.connectionStatuses.length;
  await app.connected(CONFIG);
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.equal(gladys.fake.connectionStatus.connected, false, 'the pause stays');
  assert.equal(counts(world).length, 1);
  assert.ok(app.pause);
  app.stop();
});

test('test button: respects the interval and the pause; a read when due; a slow read is told', async () => {
  const { app, gladys, start, wait, world, clock } = await setup();
  await start();
  const held = await app.testConnection();
  assert.match(held.en, /next one possible in 1 min/);
  assert.equal(counts(world).length, 1);
  await wait(TIMINGS.testCooldown / 2);
  assert.equal(
    (await app.testConnection()).en,
    'Connected: 1/1 device read.',
    'the status within the cooldown, no read',
  );
  clock.now += MINUTE;
  const release = world.hold();
  const pending = app.testConnection();
  await settle();
  assert.equal(counts(world).length, 2);
  release();
  const answer = await pending;
  assert.match(answer.fr, /Connecté/);
  world.failNetwork();
  clock.now += MINUTE;
  await app.testConnection();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  clock.now += TIMINGS.testCooldown + 1;
  const paused = await app.testConnection();
  assert.match(paused.en, /next one possible in/);
  assert.equal(counts(world).length, 3, 'never during a pause');
  app.stop();
});

test('commands: off by default; refused unsent with the true reason', async () => {
  const device = created();
  const target = device.features.find((f) => f.external_id === F('target-temperature'));
  const { app, gladys, start, world } = await setup({ devices: [device] });
  await start();
  const ack = await gladys.fake.setValue(device, target, 21);
  assert.equal(ack.success, false);
  assert.match(ack.error, /commandes de consigne sont désactivées/);
  assert.equal(writes(world).length, 0);
  const mode = device.features.find((f) => f.external_id === F('mode'));
  const modeAck = await gladys.fake.setValue(device, mode, 'night');
  assert.match(modeAck.error, /mode et de programme sont désactivées/);
  const temperature = device.features.find((f) => f.external_id === F('temperature'));
  assert.match((await gladys.fake.setValue(device, temperature, 1)).error, /lecture seule/);
  app.stop();
});

test('setpoint: a fresh read, the limits of the device and the ceiling, the echo, follow-up reads', async () => {
  const device = created();
  const target = device.features.find((f) => f.external_id === F('target-temperature'));
  const { app, gladys, start, wait, world } = await setup({
    devices: [device],
    config: { ...CONFIG, allow_setpoints: true, max_setpoint: 23 },
  });
  await start();
  await wait(SECOND);
  const before = reads(world).length;
  const ack = await gladys.fake.setValue(device, target, 21.5);
  assert.deepEqual(ack, { success: true });
  assert.equal(reads(world).length, before + 1, 'a fresh read of the device');
  assert.equal(writes(world).length, 1);
  assert.equal(writes(world)[0].path, '/cgi-bin/writeVal.cgi?G0.SollTemp=2150.0');
  assert.equal(world.devices[0].SollTemp, '2150');
  assert.equal(
    gladys.fake.lastState(F('target-temperature')),
    22,
    'published by the follow-up read, not by the command',
  );
  await wait(TIMINGS.followUps[0]);
  assert.equal(gladys.fake.lastState(F('target-temperature')), 21.5);
  await wait(TIMINGS.followUps[1]);
  assert.equal(reads(world).length, before + 3, 'two follow-up reads');
  // Bounds: the ceiling, the limits of the device, steps.
  await wait(TIMINGS.commandSpacing);
  assert.match((await gladys.fake.setValue(device, target, 23.5)).error, /de 5 à 23 °C/);
  assert.match((await gladys.fake.setValue(device, target, 4)).error, /de 5 à 23 °C/);
  assert.match((await gladys.fake.setValue(device, target, 21.55)).error, /pas de 0,1/);
  assert.match((await gladys.fake.setValue(device, target, '')).error, /pas une température/);
  assert.match((await gladys.fake.setValue(device, target, null)).error, /pas une température/);
  world.devices[0].SollTempMaxVal = '2000';
  assert.match((await gladys.fake.setValue(device, target, 22)).error, /de 5 à 20 °C/);
  world.devices[0].SollTempMaxVal = '';
  assert.match((await gladys.fake.setValue(device, target, 15)).error, /limites de consigne/);
  assert.equal(writes(world).length, 1, 'nothing else written');
  app.stop();
});

test('mode and program: one write each, the option checked before the first byte', async () => {
  const device = created();
  const mode = device.features.find((f) => f.external_id === F('mode'));
  const program = device.features.find((f) => f.external_id === F('program'));
  const { app, gladys, start, wait, world } = await setup({
    devices: [device],
    config: { ...CONFIG, allow_modes: true },
  });
  await start();
  assert.deepEqual(await gladys.fake.setValue(device, mode, 'holiday'), { success: true });
  assert.equal(writes(world).at(-1).path, '/cgi-bin/writeVal.cgi?G0.OPMode=2');
  await wait(TIMINGS.commandSpacing + TIMINGS.followUps[1]);
  assert.equal(gladys.fake.lastState(F('mode')), 'holiday');
  assert.deepEqual(await gladys.fake.setValue(device, program, 'program-2'), { success: true });
  assert.equal(writes(world).at(-1).path, '/cgi-bin/writeVal.cgi?G0.WeekProg=2');
  await wait(TIMINGS.commandSpacing + TIMINGS.followUps[1]);
  assert.match((await gladys.fake.setValue(device, program, 'program-9')).error, /inconnu/);
  assert.match((await gladys.fake.setValue(device, mode, 1)).error, /inconnu/);
  // The option turned off between the arrival and the write: nothing sent.
  const release = world.hold();
  const pending = gladys.fake.setValue(device, mode, 'night');
  await settle();
  await gladys.fake.configUpdated({ ...CONFIG, allow_modes: false });
  release();
  const ack = await pending;
  assert.match(ack.error, /désactivées/);
  assert.equal(writes(world).length, 2);
  app.stop();
});

test('commands: the position is checked (another device there), one at a time, spaced, refused in a pause', async () => {
  const device = created();
  const target = device.features.find((f) => f.external_id === F('target-temperature'));
  const { app, gladys, start, wait, world } = await setup({
    devices: [device],
    config: { ...CONFIG, allow_setpoints: true },
  });
  await start();
  world.devices.unshift(DEVICE({ kurzID: '5' }));
  assert.match((await gladys.fake.setValue(device, target, 21)).error, /Un autre appareil répond/);
  assert.equal(writes(world).length, 0);
  await wait(MINUTE);
  assert.deepEqual(await gladys.fake.setValue(device, target, 21), { success: true });
  assert.equal(writes(world)[0].path, '/cgi-bin/writeVal.cgi?G1.SollTemp=2100.0');
  assert.match(
    (await gladys.fake.setValue(device, target, 20)).error,
    /Une autre commande est en cours/,
  );
  await wait(TIMINGS.commandSpacing + TIMINGS.followUps[1]);
  const release = world.hold();
  const first = gladys.fake.setValue(device, target, 20);
  await settle();
  const second = await gladys.fake.setValue(device, target, 19);
  assert.match(second.error, /Une autre commande est en cours/);
  release();
  assert.deepEqual(await first, { success: true });
  // Unknown device, pause.
  const other = created({ kurzID: '9' });
  const otherTarget = other.features.find(
    (f) => f.external_id === F('target-temperature', '100-9'),
  );
  await wait(TIMINGS.commandSpacing + TIMINGS.followUps[1]);
  assert.match((await gladys.fake.setValue(other, otherTarget, 20)).error, /pas connu/);
  world.failNetwork();
  await wait(MINUTE);
  assert.match((await gladys.fake.setValue(device, target, 20)).error, /en pause/);
  assert.equal(writes(world).length, 2);
  app.stop();
});

test('commands: too slow is refused unsent; a write without echo is "sent, without confirmation"', async () => {
  const device = created();
  const target = device.features.find((f) => f.external_id === F('target-temperature'));
  const { app, gladys, start, wait, world, clock } = await setup({
    devices: [device],
    config: { ...CONFIG, allow_setpoints: true },
  });
  await start();
  // The fresh read answers after the budget.
  let release = world.hold();
  let pending = gladys.fake.setValue(device, target, 21);
  await settle();
  clock.now += TIMINGS.commandReadMax + 10;
  release();
  assert.match((await pending).error, /trop lentement/);
  assert.equal(writes(world).length, 0);
  await wait(MINUTE);
  world.noEcho.add('SollTemp');
  const ack = await gladys.fake.setValue(device, target, 21);
  assert.match(ack.error, /envoyée, sans confirmation/);
  assert.equal(writes(world).length, 1);
  world.noEcho.clear();
  // The controller refuses the write (4xx): told so, nothing else.
  await wait(TIMINGS.commandSpacing);
  world.queue.push(() => undefined, { status: 404, body: Buffer.from('x') });
  assert.match((await gladys.fake.setValue(device, target, 21)).error, /refusé la commande/);
  assert.equal(writes(world).length, 2);
  app.stop();
});

test('a command waits for the request in progress of a read, then goes first', async () => {
  const device = created();
  const target = device.features.find((f) => f.external_id === F('target-temperature'));
  const world = fakeController({
    devices: [DEVICE(), DEVICE({ kurzID: '2' }), DEVICE({ kurzID: '3' })],
  });
  const { app, gladys, start, wait, clock } = await setup({
    devices: [device],
    config: { ...CONFIG, allow_setpoints: true },
    world,
  });
  await start();
  clock.now += MINUTE;
  const release = world.hold();
  const run = app.tick();
  await settle();
  assert.equal(reads(world).length, 5, 'the count of the second round is held');
  const pending = gladys.fake.setValue(device, target, 21);
  await settle();
  release();
  await pending.then((ack) => assert.deepEqual(ack, { success: true }));
  await run;
  await wait(TIMINGS.followUps[1]);
  const order = world.requests
    .slice(5)
    .map((r) => (r.method === 'GET' ? 'write' : (/G\d/.exec(String(r.body))?.[0] ?? 'count')));
  assert.deepEqual(
    order.slice(0, 3),
    ['G0', 'write', 'G0'],
    'the fresh read and the write before the devices of the round',
  );
  app.stop();
});

test('wiring: index.js handlers through the fake Gladys; shutdown stops the timers', async () => {
  const gladys = createFakeGladys({ selector: 'roth', config: CONFIG, devices: [created()] });
  const world = fakeController();
  const lines = [];
  const app = new TouchlineApp({
    gladys,
    logger: {
      info: () => {},
      warn: (l) => lines.push(l),
      error: (l) => lines.push(l),
      debug: () => {},
    },
    transport: world.transport,
    store: memoryStore(),
  });
  registerHandlers(gladys, app, { error: (l) => lines.push(l) });
  gladys.handleShutdown(() => app.stop());
  await gladys.connect();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.equal((await gladys.fake.action('test_connection', {})).success, true);
  await gladys.fake.scanRequest();
  await gladys.fake.deviceDeleted(created());
  await gladys.fake.shutdown();
  assert.equal(app.timer, undefined);
  assert.equal(app.client, undefined);
  assert.deepEqual(lines, []);
});
