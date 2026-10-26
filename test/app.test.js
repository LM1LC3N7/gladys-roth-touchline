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
  const { app, start, world, cmd } = await setup({ devices: [device] });
  await start();
  const ack = await cmd(device, target, 21);
  assert.equal(ack.success, false);
  assert.match(ack.error, /commandes de consigne sont désactivées/);
  assert.equal(writes(world).length, 0);
  const mode = device.features.find((f) => f.external_id === F('mode'));
  const modeAck = await cmd(device, mode, 'night');
  assert.match(modeAck.error, /mode et de programme sont désactivées/);
  const temperature = device.features.find((f) => f.external_id === F('temperature'));
  assert.match((await cmd(device, temperature, 1)).error, /lecture seule/);
  app.stop();
});

test('setpoint: a fresh read, the limits of the device and the ceiling, the echo, follow-up reads', async () => {
  const device = created();
  const target = device.features.find((f) => f.external_id === F('target-temperature'));
  const { app, gladys, start, wait, world, cmd } = await setup({
    devices: [device],
    config: { ...CONFIG, allow_setpoints: true, max_setpoint: 23 },
  });
  await start();
  await wait(SECOND);
  const before = reads(world).length;
  const ack = await cmd(device, target, 21.5);
  assert.deepEqual(ack, { success: true });
  assert.equal(reads(world).length, before + 2, 'a fresh read, then the read back that confirms');
  assert.equal(writes(world).length, 1);
  assert.equal(writes(world)[0].path, '/cgi-bin/writeVal.cgi?G0.SollTemp=2150.0');
  assert.equal(world.devices[0].SollTemp, '2150');
  assert.equal(
    gladys.fake.lastState(F('target-temperature')),
    21.5,
    'published from the read back, never from the command itself',
  );
  await wait(TIMINGS.followUps[1]);
  assert.equal(reads(world).length, before + 4, 'two follow-up reads');
  // Bounds: the ceiling, the limits of the device, steps.
  await wait(TIMINGS.commandSpacing);
  assert.match((await cmd(device, target, 23.5)).error, /de 5 à 23 °C/);
  assert.match((await cmd(device, target, 4)).error, /de 5 à 23 °C/);
  assert.match((await cmd(device, target, 21.55)).error, /pas de 0,1/);
  assert.match((await cmd(device, target, '')).error, /pas une température/);
  assert.match((await cmd(device, target, null)).error, /pas une température/);
  world.devices[0].SollTempMaxVal = '2000';
  assert.match((await cmd(device, target, 22)).error, /de 5 à 20 °C/);
  // The high limit rounded down, never up (review r1, minor 8).
  world.devices[0].SollTempMaxVal = '2155';
  assert.match((await cmd(device, target, 21.6)).error, /de 5 à 21.5 °C/);
  world.devices[0].SollTempMaxVal = '';
  assert.match((await cmd(device, target, 15)).error, /n’ont pas pu être lues/);
  // Inconsistent limits are told as such (review r1, minor 9).
  world.devices[0].SollTempMaxVal = '1000';
  world.devices[0].SollTempMinVal = '2000';
  assert.match((await cmd(device, target, 15)).error, /incohérentes/);
  assert.equal(writes(world).length, 1, 'nothing else written');
  app.stop();
});

test('mode and program: one write each, the option checked before the first byte', async () => {
  const device = created();
  const mode = device.features.find((f) => f.external_id === F('mode'));
  const program = device.features.find((f) => f.external_id === F('program'));
  const { app, gladys, start, wait, world, cmd } = await setup({
    devices: [device],
    config: { ...CONFIG, allow_modes: true },
  });
  await start();
  assert.deepEqual(await cmd(device, mode, 'holiday'), { success: true });
  assert.equal(writes(world).at(-1).path, '/cgi-bin/writeVal.cgi?G0.OPMode=2');
  await wait(TIMINGS.commandSpacing + TIMINGS.followUps[1]);
  assert.equal(gladys.fake.lastState(F('mode')), 'holiday');
  assert.deepEqual(await cmd(device, program, 'program-2'), { success: true });
  assert.equal(writes(world).at(-1).path, '/cgi-bin/writeVal.cgi?G0.WeekProg=2');
  await wait(TIMINGS.commandSpacing + TIMINGS.followUps[1]);
  assert.match((await cmd(device, program, 'program-9')).error, /inconnu/);
  assert.match((await cmd(device, mode, 1)).error, /inconnu/);
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

test('commands: the position is checked, no thermostat there, unknown device, refused in a pause', async () => {
  const device = created();
  const target = device.features.find((f) => f.external_id === F('target-temperature'));
  const { app, start, wait, world, cmd } = await setup({
    devices: [device],
    config: { ...CONFIG, allow_setpoints: true },
  });
  await start();
  world.devices.unshift(DEVICE({ kurzID: '5' }));
  assert.match((await cmd(device, target, 21)).error, /Un autre appareil répond/);
  assert.equal(writes(world).length, 0);
  await wait(MINUTE);
  assert.deepEqual(await cmd(device, target, 21), { success: true });
  assert.equal(writes(world)[0].path, '/cgi-bin/writeVal.cgi?G1.SollTemp=2100.0');
  // Nothing answers at the position now (review r1, minor 9): the true reason.
  world.devices.length = 1;
  assert.match((await cmd(device, target, 20)).error, /Aucun thermostat ne répond/);
  const other = created({ kurzID: '9' });
  const otherTarget = other.features.find(
    (f) => f.external_id === F('target-temperature', '100-9'),
  );
  assert.match((await cmd(other, otherTarget, 20)).error, /pas connu/);
  // The follow-ups of the write are done before the controller fails.
  await wait(TIMINGS.followUps[1]);
  world.failNetwork();
  await wait(MINUTE);
  assert.match((await cmd(device, target, 20)).error, /en pause/);
  assert.equal(writes(world).length, 1);
  app.stop();
});

test('scene: four rooms set in a row, or at once, are all written, one at a time (review r1, point 3)', async () => {
  const rooms = [1, 2, 3, 4].map((id) => DEVICE({ kurzID: String(id) }));
  const world = fakeController({ devices: rooms });
  const devices = [1, 2, 3, 4].map((id, i) => created({ kurzID: String(id) }, { index: i }));
  const targets = devices.map((d) =>
    d.features.find((f) => f.external_id.endsWith(':target-temperature')),
  );
  const { app, gladys, start, act, cmd } = await setup({
    devices,
    world,
    config: { ...CONFIG, allow_setpoints: true },
  });
  await start();
  // In a row: each action waits for the ack of the previous one (a Gladys scene in series).
  for (let i = 0; i < 4; i += 1) {
    assert.deepEqual(await cmd(devices[i], targets[i], 19), { success: true }, `room ${i + 1}`);
  }
  assert.deepEqual(
    world.devices.map((d) => d.SollTemp),
    ['1900', '1900', '1900', '1900'],
  );
  // At once (a Gladys scene in parallel): queued, served one at a time, all written.
  const acks = await act(
    Promise.all(devices.map((d, i) => gladys.fake.setValue(d, targets[i], 18))),
  );
  assert.deepEqual(
    acks,
    devices.map(() => ({ success: true })),
  );
  assert.deepEqual(
    world.devices.map((d) => d.SollTemp),
    ['1800', '1800', '1800', '1800'],
  );
  // One write at a time, spaced from the answer of the previous one.
  const at = writes(world).map((r) => r.at);
  for (let i = 1; i < at.length; i += 1) {
    assert.ok(at[i] - at[i - 1] >= TIMINGS.commandSpacing, `write ${i}: ${at[i] - at[i - 1]} ms`);
  }
  // The queue is bounded: beyond 8 waiting, refused at once, nothing sent for it.
  const many = Array.from({ length: 10 }, () => gladys.fake.setValue(devices[0], targets[0], 17));
  const results = await act(Promise.all(many));
  assert.match(results[9].error, /8 commandes attendent déjà/);
  assert.ok(results.slice(0, 9).some((r) => r.success));
  assert.ok(
    results
      .filter((r) => !r.success && !/attendent déjà/.test(r.error))
      .every((r) => /Non envoyée à temps/.test(r.error)),
    'a command that cannot leave in time says why',
  );
  app.stop();
});

test('confirmation: an echo without effect is told, in the ack, the status and the badge (review r1, point 1)', async () => {
  const device = created();
  const target = device.features.find((f) => f.external_id === F('target-temperature'));
  const { app, gladys, start, wait, world, cmd, lines } = await setup({
    devices: [device],
    config: { ...CONFIG, allow_setpoints: true },
  });
  await start();
  world.echoOnly.add('SollTemp');
  const ack = await cmd(device, target, 21);
  assert.equal(ack.success, false);
  assert.match(ack.error, /la relecture donne 22 °C au lieu de 21 °C/);
  assert.equal(world.devices[0].SollTemp, '2200');
  assert.ok(lines.some((l) => /did not take effect \(read 2200, written 2100\)/.test(l)));
  assert.match(
    gladys.fake.connectionStatus.message.fr,
    /Commande sans effet : Living room \(Touchline\) : 22 °C ≠ 21 °C/,
  );
  assert.equal(gladys.fake.transports.at(-1).degraded, true);
  // The follow-ups still see it; once the checks are spent, the next read clears the warning.
  await wait(TIMINGS.followUps[1]);
  assert.match(gladys.fake.connectionStatus.message.en, /Command without effect/);
  await wait(MINUTE);
  assert.doesNotMatch(gladys.fake.connectionStatus.message.en, /Command without effect/);
  assert.equal(gladys.fake.transports.at(-1).degraded, undefined);
  // A slow echo (after 2.8 s): no time to read back within the ack; the follow-up confirms.
  world.echoOnly.clear();
  world.writeCost = 3 * SECOND;
  const slow = await cmd(device, target, 21);
  assert.match(slow.error, /envoyée et renvoyée par le régulateur : vérification/);
  assert.equal(world.devices[0].SollTemp, '2100');
  await wait(TIMINGS.followUps[0]);
  assert.equal(gladys.fake.lastState(F('target-temperature')), 21);
  assert.doesNotMatch(gladys.fake.connectionStatus.message.en, /Command without effect/);
  app.stop();
});

test('confirmation: a round never publishes a value read before a write; follow-ups are never skipped (review r1, point 1)', async () => {
  const device = created();
  const target = device.features.find((f) => f.external_id === F('target-temperature'));
  const world = fakeController({ devices: [DEVICE(), DEVICE({ kurzID: '2' })] });
  const { app, gladys, start, clock } = await setup({
    devices: [device],
    world,
    config: { ...CONFIG, allow_setpoints: true },
  });
  await start();
  clock.now += MINUTE;
  let ack;
  // Round 2: the count, G0 (22 °C), then while G1 is read the user sets G0 to 21 °C.
  world.queue.push(
    () => undefined,
    () => undefined,
    () => {
      ack = gladys.fake.setValue(device, target, 21);
      return undefined;
    },
  );
  await app.tick();
  assert.deepEqual(await ack, { success: true });
  assert.equal(world.devices[0].SollTemp, '2100');
  const published = gladys.fake.states
    .filter((s) => s.device_feature_external_id === F('target-temperature'))
    .map((s) => s.state);
  assert.equal(published.at(-1), 21, 'the 22 °C read before the write is not published after it');
  // A follow-up during a round waits its turn instead of being skipped.
  app.running = new Promise(() => {});
  const before = reads(world).length;
  await app.followUp(0, '100-1');
  assert.equal(reads(world).length, before + 1);
  app.running = undefined;
  app.stop();
});

test('rotation: a slow controller, every device read in turn, the controller rests (review r1, point 2)', async () => {
  const world = fakeController({
    devices: [0, 1, 2, 3, 4, 5].map((i) => DEVICE({ kurzID: String(i + 1) })),
  });
  const { app, start, wait } = await setup({ world, config: { ...CONFIG, poll_interval: 30 } });
  world.cost = 9 * SECOND;
  await start();
  await wait(3 * MINUTE);
  const rounds = [];
  for (const r of reads(world)) {
    const body = String(r.body);
    if (body.includes('totalNumberOfDevices')) rounds.push({ at: r.at, end: r.at, read: [] });
    else rounds.at(-1).read.push(Number(/G(\d+)\./.exec(body)[1]));
    rounds.at(-1).end = r.at + world.cost;
  }
  assert.ok(rounds.length >= 4, `${rounds.length} rounds`);
  const seen = new Set(rounds.slice(0, 3).flatMap((r) => r.read));
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4, 5], 'all read within three rounds');
  assert.deepEqual(
    rounds[1].read.slice(0, 1),
    [rounds[0].read.at(-1) + 1],
    'the next round goes on',
  );
  for (let i = 1; i < rounds.length; i += 1) {
    assert.ok(rounds[i].at - rounds[i - 1].end >= 15 * SECOND - 1, `rest before round ${i}`);
    assert.ok(rounds[i].at - rounds[i - 1].at >= 30 * SECOND - 1, `interval before round ${i}`);
  }
  // The budget: no new device past 20 s (interval 30 s minus 10 s).
  assert.ok(rounds.every((r) => r.read.length <= 3));
  app.stop();
});

test('configuration of Gladys unreadable at start: new tries, a status, commands refused with the true reason (review r1, point 4)', async () => {
  const device = created();
  const target = device.features.find((f) => f.external_id === F('target-temperature'));
  const { app, gladys, wait, world, cmd } = await setup({ devices: [device] });
  let calls = 0;
  await app.onConnected(async () => {
    calls += 1;
    if (calls <= 2) throw new Error('Request timeout');
    return { ...CONFIG, allow_setpoints: true };
  });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(
    gladys.fake.connectionStatus.message.fr,
    /pas encore pu être lue\. Nouvel essai dans 5 s/,
  );
  assert.match((await gladys.fake.setValue(device, target, 21)).error, /pas encore chargée/);
  await wait(5 * SECOND);
  assert.match(gladys.fake.connectionStatus.message.en, /New try in 15 s/);
  assert.equal(reads(world).length, 0);
  await wait(15 * SECOND);
  assert.equal(calls, 3);
  assert.equal(counts(world).length, 1, 'started once the configuration is read');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.deepEqual(await cmd(device, target, 21), { success: true });
  app.shutdown();
});

test('a write that never left is "not sent", with its reason, and no follow-up (review r1, point 5)', async () => {
  const device = created();
  const target = device.features.find((f) => f.external_id === F('target-temperature'));
  const { app, start, world, cmd } = await setup({
    devices: [device],
    config: { ...CONFIG, allow_setpoints: true },
  });
  await start();
  world.refuseWrite = true;
  const ack = await cmd(device, target, 21);
  assert.match(ack.error, /Commande non envoyée : le régulateur est injoignable/);
  assert.equal(world.devices[0].SollTemp, '2200');
  assert.equal(app.followUps.size, 0);
  assert.equal(app.lastWriteAt, undefined, 'no spacing for a write that never left');
  app.stop();
});

test('freshness: a device created or updated after a failed read gets no old value (review r1, point 6)', async () => {
  const { app, gladys, start, wait, world } = await setup();
  await start();
  world.failNetwork();
  await wait(MINUTE);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  await gladys.fake.deviceCreated(created());
  await gladys.fake.deviceUpdated(created({ name: 'Renamed' }));
  await wait(SECOND);
  assert.equal(gladys.fake.states.length, 0);
  app.stop();
});

test('every device failing is a failed round, not "connected" (review r1, minor 7)', async () => {
  const world = fakeController({ devices: [DEVICE(), DEVICE({ kurzID: '2' })] });
  const { app, gladys, start } = await setup({ world });
  world.queue.push(
    () => undefined,
    { status: 500, body: Buffer.from('x') },
    { status: 500, body: Buffer.from('x') },
  );
  await start();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /answered an error \(HTTP 500\)\. New try in 1 min/,
  );
  assert.ok(app.pause);
  app.stop();
});

test('the status lists 5 unread devices at most (review r1, minor 11)', async () => {
  const world = fakeController();
  const { app, gladys, start } = await setup({ world });
  world.queue.push({
    status: 200,
    body: Buffer.from(
      '<body><item_list><i><n>totalNumberOfDevices</n><v>999999</v></i></item_list></body>',
    ),
  });
  await start();
  const message = gladys.fake.connectionStatus.message.en;
  assert.match(
    message,
    /1\/32 devices read\. Not read: G1 .*G5 \(not in the answer\) and 26 more\./,
  );
  assert.ok(message.length < 300, `${message.length} characters`);
  app.stop();
});

test('commands: too slow is refused unsent; a write without echo is "sent, without confirmation"', async () => {
  const device = created();
  const target = device.features.find((f) => f.external_id === F('target-temperature'));
  const { app, gladys, start, wait, world, clock, cmd } = await setup({
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
  const ack = await cmd(device, target, 21);
  assert.match(ack.error, /envoyée, sans confirmation/);
  assert.equal(writes(world).length, 1);
  world.noEcho.clear();
  // The controller refuses the write (4xx): told so, nothing else.
  await wait(TIMINGS.commandSpacing);
  world.queue.push(() => undefined, { status: 404, body: Buffer.from('x') });
  assert.match((await cmd(device, target, 21)).error, /refusé la commande/);
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
