// -----------------------------------------------------------------------------
// The integration: the Roth Touchline controller typed in the configuration
// (its local address), one read of its devices every poll interval, one
// Gladys device per room thermostat and its states, the transport badges,
// the "Test the connection" button, and the three commands (the setpoint,
// the mode, the week program), each refused unless its option allows it.
// index.js only wires the SDK handlers.
//
// One read = the number of devices, then each device `G<i>` in turn, one
// request at a time (the CGI is slow). A device that does not answer leaves
// only that device unread (the others go on); a round never lasts longer
// than its budget, the devices left wait for the next round. The number of
// devices failing fails the round. The values of a round always go to the
// device of the ids read in that round, never to another one.
//
// The pace is global and kept across restarts: never two reads less than an
// interval apart, whatever asks (a reconnection, a save of the form, the
// test button, the Discover tab, a restart of the container: the time of the
// last attempt is kept in /data). A failed round pauses 1, 2, 5, 10 then
// 15 min, never under the interval, the pause kept in /data; a reconnection
// to Gladys clears nothing. The integration is never left without a timer.
//
// Two clocks: `now` (wall clock) dates what /data keeps; `monotonic` paces
// the reads, the pauses, the budgets and the guards, so that a wall clock
// set back or forward never stops nor hurries them. The clock is read once
// per decision (`dueAt(mono)` computes on the caller's instant).
//
// The commands follow the rules learnt on the previous modules (as the
// sibling gladys-touchline-sl):
//   - decided on a fresh read of the device only, never on the values kept
//     in memory, with its ids checked against the target;
//   - the options and the bounds are checked on arrival, after the fresh
//     read and right before the request leaves (beforeSend);
//   - sent within 3.5 s of the click or refused unsent; answered by 4.3 s;
//   - a write that may have reached the controller is never answered "not
//     sent": "sent, without confirmation", then spaced reads of the device;
//   - the ack never waits for a publication to Gladys;
//   - one command at a time, spaced; never retried.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { isComplete, normalizeConfig } from './config.js';
import { API, FEATURES as F, SETPOINT, TIMINGS } from './constants.js';
import {
  COMMAND_ROLES,
  buildDevice,
  deviceIds,
  deviceStates,
  parseDeviceId,
  parseFeatureId,
} from './devices.js';
import { ERRORS, T, age, both, join, reasonOf, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';
import { TouchlineClient } from './touchline/client.js';
import { TouchlineError, errorReason } from './touchline/http.js';
import { modeCode, platformId, programCode } from './touchline/model.js';

/** A number sent by Gladys: a finite number, or a plain decimal text ('' and null are not 0). */
function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^-?\d{1,3}(\.\d{1,3})?$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

export class TouchlineApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'roth-touchline' }),
    transport,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.transport = transport;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null);
    this.client = undefined;
    /** platformId -> { device, index, at (monotonic) }: the devices of the last round. */
    this.devices = new Map();
    /** The last round: { count, unread: [{ index, code }] } or undefined. */
    this.round = undefined;
    this.lastReadAt = undefined;
    this.pause = undefined;
    this.failures = 0;
    this.offline = false;
    this.lastWriteAt = undefined;
    this.timer = undefined;
    this.followUps = new Set();
    this.running = undefined;
    this.inFlight = undefined;
    this.generation = 0;
    this.started = false;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badges = new Map();
    this.lastTestAt = -Infinity;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    try {
      await this.startNow(raw);
    } catch (err) {
      // Never left without a timer, whatever failed.
      this.logger.error(`roth-touchline: start failed (${err?.name ?? 'Error'})`);
      this.failures += 1;
      this.setPause(this.monotonic(), this.interval);
      this.schedule();
    }
  }

  async startNow(raw = {}) {
    this.stop();
    await this.running;
    this.config = normalizeConfig(raw);
    this.reset();
    const now = this.now();
    const mono = this.monotonic();
    let loaded = null;
    try {
      loaded = await this.store.load();
    } catch (err) {
      this.logger.warn(
        `roth-touchline: /data unreadable (${err?.code ?? 'error'}): starting afresh`,
      );
    }
    const saved = normalizeMemory(loaded, now);
    // The time of the last attempt applies whatever the controller (never two reads within an interval).
    if (saved.lastAttemptAt !== null) {
      this.lastReadAt = mono - (now - saved.lastAttemptAt);
    }
    if (saved.key !== this.config.key) {
      // Another controller: the pause and the last write of the previous one are not its own.
      saved.key = this.config.key;
      saved.pause = null;
      saved.lastWriteAt = null;
    }
    this.memory = saved;
    if (saved.pause && saved.pause.until > now) {
      this.pause = { due: mono + (saved.pause.until - now), failures: saved.pause.failures };
      this.failures = saved.pause.failures;
    }
    if (saved.lastWriteAt !== null) {
      this.lastWriteAt = mono - (now - saved.lastWriteAt);
    }
    this.publisher.start();
    const missing = this.configMessage();
    if (missing) {
      await this.setStatus(false, missing);
      return;
    }
    this.client = new TouchlineClient({
      host: this.config.host,
      port: this.config.port,
      transport: this.transport,
      monotonic: this.monotonic,
    });
    await this.saveMemory();
    await this.setStatus(false, this.pause ? this.pauseMessage(mono) : T.connecting);
    await this.publishDevices();
    this.schedule();
    // A read now when it is due (a fresh install reads at once).
    await this.tick();
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    for (const timer of this.followUps) {
      this.timers.clearTimeout(timer);
    }
    this.followUps.clear();
    this.publisher.stop();
    this.client = undefined;
  }

  clearTimer() {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  reset() {
    this.devices.clear();
    this.round = undefined;
    this.pause = undefined;
    this.failures = 0;
    this.offline = false;
    this.lastWriteAt = undefined;
    this.published = undefined;
    this.badges.clear();
  }

  /** What the configuration lacks, as a status message; undefined when complete. */
  configMessage() {
    if (this.config.addressError === 'path') {
      return T.addressPath;
    }
    if (this.config.addressError === 'https') {
      return T.addressHttps;
    }
    if (this.config.addressError === 'invalid') {
      return T.addressInvalid;
    }
    return isComplete(this.config) ? undefined : T.noConfig;
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only. The pause and the
   * client stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw);
    this.published = undefined;
    this.badges.clear();
    const status = this.lastStatus;
    this.lastStatus = undefined;
    if (status) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    await this.publishDevices();
    await this.publishBadges();
  }

  /** New address: restart; new options, ceiling or language: apply at once. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    const previous = this.config;
    if (
      next.host !== previous.host ||
      next.port !== previous.port ||
      next.addressError !== previous.addressError
    ) {
      return this.start(raw);
    }
    this.config = next;
    if (
      next.allowSetpoints !== previous.allowSetpoints ||
      next.allowModes !== previous.allowModes
    ) {
      this.logger.info(
        `roth-touchline commands: setpoints ${next.allowSetpoints ? 'allowed' : 'off'}, modes ${next.allowModes ? 'allowed' : 'off'}`,
      );
    }
    if (next.pollInterval !== previous.pollInterval) {
      this.schedule();
    }
    if (next.language !== previous.language) {
      this.published = undefined;
      await this.publishDevices();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  get lastMessage() {
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? undefined;
  }

  /** true when /data was written. A failure is logged once until a save succeeds again. */
  async saveMemory() {
    try {
      await this.store.save(this.memory);
      this.saveFailed = false;
      return true;
    } catch (err) {
      if (!this.saveFailed) {
        this.saveFailed = true;
        this.logger.warn(`Saving the state to /data failed: ${err?.message ?? err}`);
      }
      return false;
    }
  }

  /** The time of an attempt, kept in /data BEFORE the read (a restart never reads sooner). */
  async saveAttempt(now) {
    this.memory.lastAttemptAt = now;
    await this.saveMemory();
  }

  /** The pause and the last write, dated on the wall clock, kept in /data. */
  async persist(mono) {
    const now = this.now();
    this.memory.key = this.config.key;
    this.memory.pause = this.pause
      ? { until: now + Math.max(0, this.pause.due - mono), failures: this.failures }
      : null;
    this.memory.lastWriteAt =
      this.lastWriteAt === undefined ? null : now - Math.max(0, mono - this.lastWriteAt);
    await this.saveMemory();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  // --- Pace ------------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * 1000;
  }

  /** The rest of the pause (ms), capped at every use; 0 when none. */
  pauseLeft(mono) {
    if (!this.pause) {
      return 0;
    }
    return Math.min(Math.max(0, this.pause.due - mono), TIMINGS.pauseMax);
  }

  /** The monotonic time from which the next read may start, from the caller's instant `mono`. */
  dueAt(mono) {
    const due = this.lastReadAt === undefined ? mono : this.lastReadAt + this.interval;
    return Math.max(due, mono + this.pauseLeft(mono));
  }

  setPause(mono, wait) {
    this.pause = { due: mono + Math.min(wait, TIMINGS.pauseMax), failures: this.failures };
  }

  /** The status during a pause (after a restart, the reason of the failure is not kept). */
  pauseMessage(mono) {
    if (!this.pause) {
      return undefined;
    }
    const reason =
      this.lastReason ?? both('earlier reads failed', 'les lectures précédentes ont échoué');
    return T.unreachable(reason, age(this.pauseLeft(mono)));
  }

  /** One timer: the next read when it is due. */
  schedule() {
    this.clearTimer();
    if (!this.client) {
      return;
    }
    const mono = this.monotonic();
    const wait = Math.max(0, this.dueAt(mono) - mono);
    const generation = this.generation;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      // The promise is returned for the tests (a virtual clock awaits it); tick() never rejects.
      return generation === this.generation ? this.tick() : undefined;
    }, wait);
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    if (!this.running) {
      const generation = this.generation;
      this.running = this.read()
        .catch((err) => this.recover(err, generation))
        .finally(() => {
          this.running = undefined;
        });
    }
    return this.running;
  }

  /** An internal error (a bug, never an answer of the controller): a pause, and the next read scheduled. */
  async recover(err, generation) {
    this.logger.error(
      `roth-touchline: unexpected error (${err?.name ?? 'Error'}: ${err?.message ?? err})`,
    );
    if (generation !== this.generation) {
      return;
    }
    this.failures += 1;
    this.setPause(this.monotonic(), this.interval);
    this.schedule();
  }

  async read() {
    const generation = this.generation;
    const client = this.client;
    if (!client) {
      return;
    }
    const mono = this.monotonic();
    if (mono < this.dueAt(mono)) {
      this.schedule();
      return;
    }
    /** Another address (or a stop) during an await: this read gives up, silently. */
    const gone = () => generation !== this.generation;
    this.lastReadAt = mono;
    // Kept BEFORE the read: a restart during it never reads again sooner.
    await this.saveAttempt(this.now());
    if (gone()) return;
    let result;
    try {
      result = await this.readAll(client, gone, mono);
    } catch (err) {
      if (gone()) return;
      await this.failed(err, mono);
      this.schedule();
      return;
    }
    if (gone() || !result) return;
    await this.succeeded(result, mono);
    if (!gone()) {
      this.schedule();
    }
  }

  /**
   * The number of devices, then each device in turn. Throws for the whole
   * round only on the count. A device failing (even a timeout) only leaves
   * that device unread; a round never takes longer than its budget.
   */
  async readAll(client, gone, started) {
    const count = await client.count({ deadline: this.monotonic() + TIMINGS.requestTimeout });
    if (gone()) return undefined;
    const devices = [];
    const unread = [];
    for (let index = 0; index < count; index += 1) {
      // A command waiting goes first (one request at a time on the controller).
      if (this.inFlight) {
        await this.inFlight.catch(() => {});
        if (gone()) return undefined;
      }
      if (this.monotonic() - started >= TIMINGS.roundBudget) {
        unread.push({ index, code: 'budget' });
        continue;
      }
      try {
        const device = await client.device(index, {
          deadline: this.monotonic() + TIMINGS.requestTimeout,
        });
        if (gone()) return undefined;
        if (device === undefined) {
          unread.push({ index, code: 'absent' });
        } else {
          devices.push(device);
        }
      } catch (err) {
        if (gone()) return undefined;
        if (!(err instanceof TouchlineError)) {
          throw err;
        }
        unread.push({ index, code: err.code });
        this.logger.warn(`roth-touchline: G${index} not read: ${errorReason(err)}`);
      }
    }
    return { count, devices, unread };
  }

  async succeeded({ count, devices, unread }, mono) {
    this.pause = undefined;
    this.failures = 0;
    this.offline = false;
    this.lastReason = undefined;
    this.devices.clear();
    // Two devices with the same ids in one round: neither is trusted (they would mix their values).
    const seen = new Map();
    for (const device of devices) {
      const key = platformId(device);
      if (key === undefined) {
        unread.push({ index: device.index, code: 'no_id' });
        continue;
      }
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const device of devices) {
      const key = platformId(device);
      if (key === undefined) {
        continue;
      }
      if (seen.get(key) > 1) {
        unread.push({ index: device.index, code: 'duplicate' });
        continue;
      }
      this.devices.set(key, { device, index: device.index, at: mono });
      this.queueStates(device);
    }
    this.round = { count, unread: unread.sort((a, b) => a.index - b.index) };
    await this.persist(mono);
    await this.setStatus(true, this.statusMessage());
    await this.publishDevices();
    await this.publishBadges();
    await this.flush();
  }

  /** The count failed: a pause, never under the interval, the devices of the last round kept for Discovery only. */
  async failed(err, mono) {
    const reason = err instanceof TouchlineError ? errorReason(err) : 'internal error';
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)],
    );
    this.failures += 1;
    this.setPause(mono, wait);
    this.offline = true;
    this.lastReason = reasonOf(err);
    this.logger.warn(`roth-touchline: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    await this.persist(mono);
    await this.setStatus(false, T.unreachable(this.lastReason, age(wait)));
    await this.publishBadges();
  }

  /** "Connected: 2/3 devices read. Not read: G2 (no answer in time)." */
  statusMessage() {
    const { count, unread } = this.round;
    if (count === 0) {
      return T.noDevice;
    }
    const base = T.connected(this.devices.size, count);
    if (unread.length === 0) {
      return base;
    }
    const reasons = {
      budget: both('round too long', 'lecture trop longue'),
      absent: both('not in the answer', 'absent de la réponse'),
      no_id: both('ids unreadable', 'identifiants illisibles'),
      duplicate: both('same ids as another device', 'mêmes identifiants qu’un autre appareil'),
    };
    const list = both(
      unread
        .map((u) => `G${u.index} (${(reasons[u.code] ?? reasonOf({ code: u.code })).en})`)
        .join(', '),
      unread
        .map((u) => `G${u.index} (${(reasons[u.code] ?? reasonOf({ code: u.code })).fr})`)
        .join(', '),
    );
    return join(base, both(T.unreadDevices(list.en).en, T.unreadDevices(list.fr).fr));
  }

  // --- Gladys ----------------------------------------------------------------

  createdDevices() {
    return (this.gladys.devices ?? []).filter((d) => parseDeviceId(d.external_id) !== undefined);
  }

  createdDevice(key) {
    return (this.gladys.devices ?? []).find((d) => {
      const ids = parseDeviceId(d.external_id);
      return ids && `${ids.owner}-${ids.id}` === key;
    });
  }

  /** The features created in Gladys, by external id. */
  createdFeatures() {
    return new Map(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => [f.external_id, f])),
    );
  }

  /** The devices to publish: those read, plus those already created in Gladys (never dropped). */
  async publishDevices() {
    const keys = new Map();
    for (const [key, entry] of this.devices) {
      keys.set(key, entry.device);
    }
    for (const created of this.createdDevices()) {
      const ids = parseDeviceId(created.external_id);
      const key = `${ids.owner}-${ids.id}`;
      if (!keys.has(key)) {
        keys.set(key, undefined);
      }
    }
    if (keys.size === 0) {
      return;
    }
    const devices = [...keys.entries()]
      .sort(([, a], [, b]) => (a?.index ?? 1e9) - (b?.index ?? 1e9))
      .map(([key, device]) => {
        const [owner, id] = key.split('-').map(Number);
        return buildDevice(
          this.gladys,
          { owner, id },
          { device, language: this.config.language, created: this.createdDevice(key) },
        );
      });
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  /** Queues the states of a device read, for the features created in Gladys only. */
  queueStates(device, created = this.createdFeatures()) {
    const ids = deviceIds(this.gladys, device);
    for (const [role, state] of deviceStates(device)) {
      const id = ids.feature(role);
      if (created.has(id)) {
        this.publisher.push(id, state);
      }
    }
  }

  badge(key) {
    if (this.offline) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
    }
    if (this.round && !this.devices.has(key)) {
      return {
        transport: DEVICE_TRANSPORTS.UNREACHABLE,
        degraded: true,
        message: both(
          'Not in the last read of the controller',
          'Absent de la dernière lecture du régulateur',
        ),
      };
    }
    return { transport: DEVICE_TRANSPORTS.LOCAL };
  }

  async publishBadges() {
    const entries = [];
    for (const device of this.createdDevices()) {
      const ids = parseDeviceId(device.external_id);
      const entry = { external_id: device.external_id, ...this.badge(`${ids.owner}-${ids.id}`) };
      const json = JSON.stringify(entry);
      if (this.badges.get(device.external_id) !== json) {
        entries.push([device.external_id, json, entry]);
      }
    }
    if (entries.length === 0) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries.map(([, , entry]) => entry));
      for (const [externalId, json] of entries) {
        this.badges.set(externalId, json);
      }
    } catch (err) {
      this.logger.warn(`Transport badges failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badges.delete(device?.external_id);
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.set(f.external_id, f);
    }
    const ids = parseDeviceId(device?.external_id);
    const entry = ids && this.devices.get(`${ids.owner}-${ids.id}`);
    if (entry) {
      this.queueStates(entry.device, created);
    }
    await this.flush();
    await this.publishBadges();
  }

  async deviceDeleted(device) {
    this.badges.delete(device?.external_id);
    if (device?.external_id) {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: a read now when it is due, else the last list. */
  async scan() {
    if (this.client && !this.running) {
      const mono = this.monotonic();
      if (mono >= this.dueAt(mono)) {
        await this.tick();
        return;
      }
    }
    await this.publishDevices();
  }

  // --- Configuration button --------------------------------------------------

  async testConnection() {
    const missing = this.configMessage();
    if (missing) {
      return missing;
    }
    const mono = this.monotonic();
    if (mono - this.lastTestAt < TIMINGS.testCooldown) {
      return this.lastMessage ?? T.connecting;
    }
    this.lastTestAt = mono;
    if (this.running) {
      return T.test.busy;
    }
    const due = this.dueAt(mono);
    if (mono < due) {
      // Never a read sooner than the interval (nor during a pause).
      return join(T.test.wait(age(due - mono)), this.lastMessage ?? T.connecting);
    }
    let handle;
    const budget = new Promise((resolve) => {
      handle = this.timers.setTimeout(() => resolve('slow'), TIMINGS.testBudget);
    });
    const result = await Promise.race([this.tick().then(() => 'done'), budget]);
    this.timers.clearTimeout(handle);
    if (result === 'slow') {
      return T.test.slow;
    }
    return this.lastMessage ?? T.connecting;
  }

  // --- The commands ----------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  /** The option of a role, read now. */
  allowed(role) {
    return role === F.TARGET ? this.config.allowSetpoints : this.config.allowModes;
  }

  disabledError(role) {
    return this.refusal(role === F.TARGET ? ERRORS.setpointsDisabled : ERRORS.modesDisabled);
  }

  /** The bounds of a setpoint, in tenths of °C: the limits of the device, within 5 °C and the ceiling. */
  bounds(device) {
    if (device.minTenths === undefined || device.maxTenths === undefined) {
      return undefined;
    }
    const low = Math.max(SETPOINT.min * 10, device.minTenths);
    const high = Math.min(SETPOINT.max * 10, this.config.ceiling * 10, device.maxTenths);
    return low <= high ? { low, high } : undefined;
  }

  /**
   * The value of a command, checked strictly (null, '' or 'abc' are not a
   * number; a mode or program is one of the exact option values). The bounds
   * of a setpoint are checked on the fresh read (the limits of the device).
   */
  parseCommand(role, value) {
    if (role === F.MODE || role === F.PROGRAM) {
      const code = role === F.MODE ? modeCode(value) : programCode(value);
      if (typeof value !== 'string' || code === undefined) {
        throw this.refusal(ERRORS.badOption);
      }
      return { parameter: role === F.MODE ? API.write.mode : API.write.program, code };
    }
    const number = numberOf(value);
    if (number === undefined) {
      throw this.refusal(ERRORS.badNumber);
    }
    if (Math.abs(number * 10 - Math.round(number * 10)) > 1e-6) {
      throw this.refusal(ERRORS.badStep);
    }
    const tenths = Math.round(number * 10);
    if (tenths < SETPOINT.min * 10 || tenths > Math.min(SETPOINT.max, this.config.ceiling) * 10) {
      throw this.refusal(
        ERRORS.outOfRange(SETPOINT.min, Math.min(SETPOINT.max, this.config.ceiling)),
      );
    }
    return { parameter: API.write.setpoint, tenths };
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.monotonic();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    if (!this.allowed(target.role)) {
      throw this.disabledError(target.role);
    }
    const wanted = this.parseCommand(target.role, value);
    if (
      this.inFlight ||
      (this.lastWriteAt !== undefined && received < this.lastWriteAt + TIMINGS.commandSpacing)
    ) {
      throw this.refusal(ERRORS.stillRunning);
    }
    const promise = this.command(target, wanted, received);
    this.inFlight = promise;
    try {
      return await promise;
    } finally {
      if (this.inFlight === promise) {
        this.inFlight = undefined;
      }
    }
  }

  /** The checks before sending, on the latest configuration and state. */
  checkBeforeSend(generation, client, role, tenths, device) {
    if (!this.allowed(role)) {
      throw this.disabledError(role);
    }
    if (generation !== this.generation || this.client !== client) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (this.pause && this.pauseLeft(this.monotonic()) > 0) {
      throw this.refusal(ERRORS.paused);
    }
    if (tenths !== undefined) {
      // The ceiling may have been lowered since the command arrived.
      const bounds = this.bounds(device);
      if (!bounds) {
        throw this.refusal(ERRORS.missingLimits);
      }
      if (tenths < bounds.low || tenths > bounds.high) {
        throw this.refusal(ERRORS.outOfRange(bounds.low / 10, bounds.high / 10));
      }
    }
  }

  async command(target, wanted, received) {
    const generation = this.generation;
    const client = this.client;
    if (!client) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    const key = `${target.owner}-${target.id}`;
    const entry = this.devices.get(key);
    if (!entry) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (this.pause && this.pauseLeft(received) > 0) {
      throw this.refusal(ERRORS.paused);
    }
    const sendBy = received + TIMINGS.commandSendBy;
    const readBy = Math.min(received + TIMINGS.commandReadMax, sendBy - TIMINGS.commandMinSend);
    // The fresh read: the device at its last known position, never the values in memory.
    let fresh;
    try {
      fresh = await client.device(entry.index, { deadline: readBy });
    } catch (err) {
      if (!(err instanceof TouchlineError)) {
        throw err;
      }
      if (err.code === 'late' || err.code === 'timeout') {
        throw this.refusal(ERRORS.tooSlow);
      }
      if (err.code === 'busy') {
        throw this.refusal(ERRORS.busy);
      }
      throw this.refusal(ERRORS.unknownState(reasonOf(err)));
    }
    if (generation !== this.generation) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (fresh === undefined || platformId(fresh) !== key) {
      // The position moved (a device removed): the next round finds it again.
      throw this.refusal(ERRORS.otherDevice);
    }
    this.checkBeforeSend(generation, client, target.role, wanted.tenths, fresh);
    const value = wanted.tenths === undefined ? wanted.code : wanted.tenths * 10;
    const answerBy = received + TIMINGS.commandAnswerBy;
    let left = false;
    try {
      await client.write(entry.index, wanted.parameter, value, {
        deadline: answerBy,
        decimal: wanted.tenths !== undefined,
        beforeSend: () => {
          // Right before the first byte: the option, the ceiling and the session again.
          this.checkBeforeSend(generation, client, target.role, wanted.tenths, fresh);
          if (this.monotonic() >= sendBy) {
            throw this.refusal(ERRORS.tooSlow);
          }
          left = true;
          this.lastWriteAt = this.monotonic();
        },
      });
    } catch (err) {
      if (left) {
        this.afterWrite(generation, entry.index, key);
      }
      if (!(err instanceof TouchlineError)) {
        throw err;
      }
      if (err.code === 'late' || (err.code === 'timeout' && !err.sent) || err.code === 'busy') {
        throw this.refusal(err.code === 'busy' ? ERRORS.busy : ERRORS.tooSlow);
      }
      if (err.code === 'http' && err.status && err.status >= 400 && err.status < 500) {
        throw this.refusal(ERRORS.refusedByController);
      }
      // The request may have reached the controller: never "not sent".
      throw this.refusal(ERRORS.unconfirmed);
    }
    this.afterWrite(generation, entry.index, key);
    return undefined;
  }

  /** After a write that left: the write dated in /data, the device read again 5 s and 20 s later. */
  afterWrite(generation, index, key) {
    this.persist(this.monotonic()).catch(() => {});
    for (const delay of TIMINGS.followUps) {
      const timer = this.timers.setTimeout(() => {
        this.followUps.delete(timer);
        if (generation !== this.generation) {
          return undefined;
        }
        return this.followUp(index, key).catch((err) =>
          this.logger.warn(`roth-touchline: follow-up read failed: ${errorReason(err)}`),
        );
      }, delay);
      this.followUps.add(timer);
    }
  }

  /** One device read again after a command: its states, when its ids are still the target's. */
  async followUp(index, key) {
    const client = this.client;
    const generation = this.generation;
    if (!client || this.inFlight || this.running) {
      return;
    }
    const device = await client.device(index, {
      deadline: this.monotonic() + TIMINGS.requestTimeout,
    });
    if (generation !== this.generation || device === undefined || platformId(device) !== key) {
      return;
    }
    const entry = this.devices.get(key);
    if (entry) {
      entry.device = device;
      entry.at = this.monotonic();
    }
    this.queueStates(device);
    await this.flush();
  }
}
