// -----------------------------------------------------------------------------
// The integration: the Roth Touchline controller typed in the configuration
// (its local address), one read of its devices every poll interval, one
// Gladys device per room thermostat and its states, the transport badges,
// the "Test the connection" button, and the three commands (the setpoint,
// the mode, the week program), each refused unless its option allows it.
// index.js only wires the SDK handlers.
//
// One round = the number of devices, then each device `G<i>` in turn, one
// request at a time (the CGI is slow). A device that does not answer leaves
// only that device unread (the others go on); every device failing fails
// the round. A round starts no new device past its budget (45 s, and never
// past the interval minus 10 s): the next round starts at the first device
// left unread, so each device is read at least every other round. The
// values of a round always go to the device of the ids read in that round,
// never to another one, and never when a write on that device left after
// the device was read.
//
// The pace is global and kept across restarts: never two rounds less than an
// interval apart (start to start), and the controller rests at least half
// an interval between the end of a round and the start of the next,
// whatever asks (a reconnection, a save of the form, the test button, the
// Discover tab, a restart: the time of the last attempt is kept in /data). A
// failed round pauses 1, 2, 5, 10 then 15 min, never under the interval, the
// pause kept in /data; a reconnection to Gladys clears nothing. The
// integration is never left without a timer, and a configuration of Gladys
// that cannot be read at start is read again (5 s, 15 s, 1 min, then every
// 5 min).
//
// Two clocks: `now` (wall clock) dates what /data keeps; `monotonic` paces
// the reads, the pauses, the budgets and the guards, so that a wall clock
// set back or forward never stops nor hurries them. The clock is read once
// per decision (`dueAt(mono)` computes on the caller's instant).
//
// The commands follow the rules learnt on the previous modules (as the
// sibling gladys-touchline-sl):
//   - a bounded queue (8): a scene setting several rooms gets them all, one
//     write at a time, each command keeping its own deadline from its
//     arrival; the round yields to the commands between two devices;
//   - decided on a fresh read of the device only, never on the values kept
//     in memory, with its ids checked against the target;
//   - the options and the bounds are checked on arrival, after the fresh
//     read and right before the request leaves (beforeSend);
//   - sent within 3.5 s of the click or refused unsent, with the true
//     reason; a write that may have reached the controller is never
//     answered "not sent";
//   - confirmed by a read back equal to the value written (the echo of the
//     controller alone is not enough): within the ack when the echo comes
//     by 2.8 s, else by the follow-up reads (5 s and 20 s, never skipped); a
//     read back that differs is told in the logs, the status and the badge;
//   - the ack never waits for a publication to Gladys.
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
import {
  ERRORS,
  MODE_NAMES,
  PROGRAM_NAMES,
  T,
  age,
  both,
  deviceName,
  join,
  reasonOf,
  word,
} from './i18n.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';
import { TouchlineClient } from './touchline/client.js';
import { TouchlineError, errorReason } from './touchline/http.js';
import { modeCode, modeOf, platformId, programCode, programOf } from './touchline/model.js';

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

/** The raw value a command writes, as a read reports it: hundredths of °C, or a code. */
function readValueOf(role, device) {
  if (role === F.TARGET) {
    return device.targetHundredths;
  }
  return role === F.MODE ? device.modeCode : device.programCode;
}

/** A raw value as the user reads it: "21.5 °C", "Night", "Program 2", "?" when unknown. */
function describe(role, value) {
  if (value === undefined) {
    return both('?', '?');
  }
  if (role === F.TARGET) {
    const text = `${value / 100} °C`;
    return both(text, text.replace('.', ','));
  }
  const name = role === F.MODE ? MODE_NAMES[modeOf(value)] : PROGRAM_NAMES[programOf(value)];
  return name ?? both(`code ${value}`, `code ${value}`);
}

/** Lists the first 5 entries, then "and N more". */
function bounded(entries, language) {
  const shown = entries.slice(0, 5).map((e) => e[language]);
  const more = entries.length - shown.length;
  return shown.join(', ') + (more > 0 ? T.andMore(more)[language] : '');
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
    this.configLoaded = false;
    this.configTries = 0;
    this.configTimer = undefined;
    this.configGeneration = 0;
    this.memory = normalizeMemory(null);
    this.client = undefined;
    /** platformId -> { device, index, at (monotonic, when the read started) }. */
    this.devices = new Map();
    /** The last round: { count, unread: [{ index, code }] } or undefined. */
    this.round = undefined;
    /** The position the next round starts at (rotation past the budget). */
    this.cursor = 0;
    this.lastReadAt = undefined;
    this.lastEndAt = undefined;
    this.pause = undefined;
    this.failures = 0;
    this.offline = false;
    /** The end of the last write that left (monotonic): the next write waits the spacing. */
    this.lastWriteAt = undefined;
    /** platformId -> the monotonic time the last write on that device left. */
    this.writtenAt = new Map();
    /** platformId -> { role, expected, checks }: a write not yet seen in a read back. */
    this.pendingWrites = new Map();
    /** platformId -> { en, fr }: a write the read back contradicts, until the next read. */
    this.warnings = new Map();
    this.timer = undefined;
    this.followUps = new Set();
    this.running = undefined;
    /** Commands waiting their turn, and the one being served. */
    this.commands = [];
    this.serving = undefined;
    this.generation = 0;
    this.started = false;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badges = new Map();
    this.lastTestAt = -Infinity;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * Connected to Gladys: the configuration is read (`load`, the SDK's
   * getConfig), and read again on failure (5 s, 15 s, 1 min, then every
   * 5 min) with a status saying so; never a dead integration.
   */
  async onConnected(load) {
    this.configLoader = load;
    this.configTries = 0;
    this.clearConfigTimer();
    await this.loadConfig();
  }

  async loadConfig() {
    const generation = ++this.configGeneration;
    let raw;
    try {
      raw = await this.configLoader();
    } catch (err) {
      if (generation !== this.configGeneration) {
        return;
      }
      const wait = TIMINGS.configRetry[Math.min(this.configTries, TIMINGS.configRetry.length - 1)];
      this.configTries += 1;
      this.logger.warn(
        `roth-touchline: configuration not read (${err?.name ?? 'Error'}); new try in ${Math.round(wait / 1000)} s`,
      );
      if (!this.configLoaded) {
        await this.setStatus(false, T.configNotRead(age(wait)));
      }
      this.clearConfigTimer();
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        return this.loadConfig().catch(() => {});
      }, wait);
      return;
    }
    if (generation !== this.configGeneration) {
      return;
    }
    this.configTries = 0;
    await this.connected(raw);
  }

  clearConfigTimer() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

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

  /** The container stops: every timer, the configuration retry included. */
  shutdown() {
    this.configGeneration += 1;
    this.clearConfigTimer();
    this.stop();
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
    this.cursor = 0;
    this.lastEndAt = undefined;
    this.pause = undefined;
    this.failures = 0;
    this.offline = false;
    this.lastWriteAt = undefined;
    this.writtenAt.clear();
    this.pendingWrites.clear();
    this.warnings.clear();
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
   * The configuration of Gladys read. The first time, start; after a
   * reconnection (Gladys restarted), resend what Gladys keeps in memory
   * only. The pause and the client stay.
   */
  async connected(raw = {}) {
    this.configLoaded = true;
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
    this.configLoaded = true;
    // The configuration is known now: a retry of its read is not needed any more.
    this.clearConfigTimer();
    if (
      !this.started ||
      next.host !== previous.host ||
      next.port !== previous.port ||
      next.addressError !== previous.addressError
    ) {
      this.started = true;
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

  /** A round starts no new device past this: 45 s, and never past the interval minus 10 s. */
  get roundBudget() {
    return Math.min(TIMINGS.roundBudget, this.interval - TIMINGS.roundMargin);
  }

  /** The rest of the pause (ms), capped at every use; 0 when none. */
  pauseLeft(mono) {
    if (!this.pause) {
      return 0;
    }
    return Math.min(Math.max(0, this.pause.due - mono), TIMINGS.pauseMax);
  }

  /**
   * The monotonic time from which the next round may start, from the
   * caller's instant `mono`: an interval after the start of the previous
   * one, half an interval after its end (the controller rests), after the
   * pause.
   */
  dueAt(mono) {
    let due = this.lastReadAt === undefined ? mono : this.lastReadAt + this.interval;
    if (this.lastEndAt !== undefined) {
      due = Math.max(due, this.lastEndAt + this.interval * TIMINGS.restShare);
    }
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
      this.lastEndAt = this.monotonic();
      await this.failed(err, mono);
      this.schedule();
      return;
    }
    if (gone() || !result) return;
    this.lastEndAt = this.monotonic();
    const failure = result.unread.find((u) => u.err)?.err;
    if (result.count > 0 && result.devices.length === 0 && failure) {
      // Every device failed: the controller is not working, not "connected".
      await this.failed(failure, mono);
    } else {
      await this.succeeded(result, mono);
    }
    if (!gone()) {
      this.schedule();
    }
  }

  /** Resolves once no command is waiting nor being served (the round yields to them). */
  async commandsIdle() {
    while (this.serving) {
      await this.serving;
    }
  }

  /**
   * The number of devices, then each device in turn from the cursor. Throws
   * for the whole round only on the count. A device failing (even a
   * timeout) only leaves that device unread; past the budget no new device
   * is started, and the next round starts at the first one left.
   */
  async readAll(client, gone, started) {
    const count = await client.count({ deadline: this.monotonic() + TIMINGS.requestTimeout });
    if (gone()) return undefined;
    const devices = [];
    const unread = [];
    const first = count > 0 ? this.cursor % count : 0;
    let stoppedAt;
    for (let k = 0; k < count; k += 1) {
      const index = (first + k) % count;
      // A command waiting goes first (one request at a time on the controller).
      await this.commandsIdle();
      if (gone()) return undefined;
      if (stoppedAt === undefined && this.monotonic() - started >= this.roundBudget) {
        stoppedAt = index;
      }
      if (stoppedAt !== undefined) {
        unread.push({ index, code: 'budget' });
        continue;
      }
      const at = this.monotonic();
      try {
        const device = await client.device(index, { deadline: at + TIMINGS.requestTimeout });
        if (gone()) return undefined;
        if (device === undefined) {
          unread.push({ index, code: 'absent' });
        } else {
          devices.push({ device, at });
        }
      } catch (err) {
        if (gone()) return undefined;
        if (!(err instanceof TouchlineError)) {
          throw err;
        }
        unread.push({ index, code: err.code, err });
        this.logger.warn(`roth-touchline: G${index} not read: ${errorReason(err)}`);
      }
    }
    this.cursor = stoppedAt ?? first;
    return { count, devices, unread };
  }

  async succeeded({ count, devices, unread }, mono) {
    this.pause = undefined;
    this.failures = 0;
    this.offline = false;
    this.lastReason = undefined;
    const previous = this.devices;
    this.devices = new Map();
    // Two devices with the same ids in one round: neither is trusted (they would mix their values).
    const seen = new Map();
    for (const { device } of devices) {
      const key = platformId(device);
      if (key === undefined) {
        unread.push({ index: device.index, code: 'no_id' });
        continue;
      }
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const { device, at } of devices) {
      const key = platformId(device);
      if (key === undefined) {
        continue;
      }
      if (seen.get(key) > 1) {
        unread.push({ index: device.index, code: 'duplicate' });
        continue;
      }
      if (at < (this.writtenAt.get(key) ?? -Infinity)) {
        // Read before a write that left since: its values are older than the write, never published.
        const kept = previous.get(key);
        this.devices.set(key, kept ?? { device, index: device.index, at });
        continue;
      }
      this.devices.set(key, { device, index: device.index, at });
      this.checkWrite(key, device, at);
      this.queueStates(device);
    }
    this.round = { count, unread: unread.sort((a, b) => a.index - b.index) };
    await this.persist(mono);
    await this.setStatus(true, this.statusMessage());
    await this.publishDevices();
    await this.publishBadges();
    await this.flush();
  }

  /** The round failed: a pause, never under the interval, the devices of the last round kept for Discovery only. */
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

  /** "Connected: 2/3 devices read. Not read: G2 (no answer in time)." (5 listed at most) */
  statusMessage() {
    const { count, unread } = this.round;
    let message = count === 0 ? T.noDevice : T.connected(this.devices.size, count);
    if (count > 0 && unread.length > 0) {
      const reasons = {
        budget: both('round too long', 'lecture trop longue'),
        absent: both('not in the answer', 'absent de la réponse'),
        no_id: both('ids unreadable', 'identifiants illisibles'),
        duplicate: both('same ids as another device', 'mêmes identifiants qu’un autre appareil'),
      };
      const entries = unread.map((u) => {
        const reason = reasons[u.code] ?? reasonOf(u.err ?? { code: u.code });
        return both(`G${u.index} (${reason.en})`, `G${u.index} (${reason.fr})`);
      });
      const list = both(bounded(entries, 'en'), bounded(entries, 'fr'));
      message = join(message, both(T.unreadDevices(list.en).en, T.unreadDevices(list.fr).fr));
    }
    if (this.warnings.size > 0) {
      const entries = [...this.warnings.values()];
      message = join(message, T.notApplied(both(bounded(entries, 'en'), bounded(entries, 'fr'))));
    }
    return message;
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
    if (this.warnings.has(key)) {
      return {
        transport: DEVICE_TRANSPORTS.LOCAL,
        degraded: true,
        message: both(
          'The last command did not take effect (read back differs)',
          'La dernière commande n’a pas pris effet (la relecture diffère)',
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

  /**
   * A device was created (or updated): its last values at once, only when
   * they are fresh (read by the last round or a later read, no failure
   * since, younger than an interval and a budget). Otherwise the next round
   * sends them.
   */
  async deviceCreated(device) {
    this.badges.delete(device?.external_id);
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.set(f.external_id, f);
    }
    const ids = parseDeviceId(device?.external_id);
    const entry = ids && this.devices.get(`${ids.owner}-${ids.id}`);
    const mono = this.monotonic();
    if (
      entry &&
      !this.offline &&
      this.pauseLeft(mono) === 0 &&
      mono - entry.at <= this.interval + this.roundBudget
    ) {
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
      // Never a read sooner than the interval (nor during a pause, nor during the rest).
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

  /**
   * The bounds of a setpoint, in tenths of °C: the limits of the device
   * (hundredths, the low one rounded up, the high one down), within 5 °C and
   * the ceiling. `{ error }` when the limits are missing or inconsistent.
   */
  bounds(device) {
    if (device.minHundredths === undefined || device.maxHundredths === undefined) {
      return { error: ERRORS.missingLimits };
    }
    if (device.minHundredths > device.maxHundredths) {
      return { error: ERRORS.inconsistentLimits };
    }
    const low = Math.max(SETPOINT.min * 10, Math.ceil(device.minHundredths / 10));
    const high = Math.min(
      SETPOINT.max * 10,
      this.config.ceiling * 10,
      Math.floor(device.maxHundredths / 10),
    );
    return low <= high ? { low, high } : { error: ERRORS.inconsistentLimits };
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

  /** A command: checked at once, then queued (8 at most) and served one at a time. */
  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.monotonic();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    if (!this.configLoaded) {
      throw this.refusal(ERRORS.configNotLoaded);
    }
    if (!this.allowed(target.role)) {
      throw this.disabledError(target.role);
    }
    const wanted = this.parseCommand(target.role, value);
    const ahead = this.commands.length + (this.serving ? 1 : 0);
    if (this.commands.length >= TIMINGS.commandQueue) {
      throw this.refusal(ERRORS.queueFull(this.commands.length));
    }
    return new Promise((resolve, reject) => {
      this.commands.push({ target, wanted, received, ahead, resolve, reject });
      this.serveCommands();
    });
  }

  serveCommands() {
    if (this.serving) {
      return this.serving;
    }
    this.serving = (async () => {
      while (this.commands.length > 0) {
        const job = this.commands.shift();
        try {
          job.resolve(await this.command(job));
        } catch (err) {
          job.reject(err);
        }
      }
    })().finally(() => {
      this.serving = undefined;
      if (this.commands.length > 0) {
        this.serveCommands();
      }
    });
    return this.serving;
  }

  sleep(ms) {
    return new Promise((resolve) => this.timers.setTimeout(resolve, ms));
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
      if (bounds.error) {
        throw this.refusal(bounds.error);
      }
      if (tenths < bounds.low || tenths > bounds.high) {
        throw this.refusal(ERRORS.outOfRange(bounds.low / 10, bounds.high / 10));
      }
    }
  }

  /** Too late to send: the true cause (the commands before it, a round, or the controller). */
  lateError(ahead, roundBusy) {
    if (ahead > 0) {
      return this.refusal(ERRORS.queueLate(ahead));
    }
    return this.refusal(roundBusy ? ERRORS.busy : ERRORS.tooSlow);
  }

  async command({ target, wanted, received, ahead }) {
    const generation = this.generation;
    const client = this.client;
    const roundBusy = Boolean(this.running);
    if (!client) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    // The pause first: when the controller is failing, that is the cause.
    if (this.pause && this.pauseLeft(this.monotonic()) > 0) {
      throw this.refusal(ERRORS.paused);
    }
    const key = `${target.owner}-${target.id}`;
    const entry = this.devices.get(key);
    if (!entry) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    const sendBy = received + TIMINGS.commandSendBy;
    const latest = sendBy - TIMINGS.commandMinSend - TIMINGS.commandMinRead;
    // Writes are spaced from the answer of the previous one.
    const mono = this.monotonic();
    const rest =
      this.lastWriteAt === undefined ? 0 : this.lastWriteAt + TIMINGS.commandSpacing - mono;
    if (rest > 0) {
      if (mono + rest > latest) {
        throw ahead > 0 ? this.refusal(ERRORS.queueLate(ahead)) : this.refusal(ERRORS.stillRunning);
      }
      await this.sleep(rest);
      if (generation !== this.generation) {
        throw this.refusal(ERRORS.unknownDevice);
      }
    }
    const start = this.monotonic();
    if (start > latest) {
      throw this.lateError(ahead, roundBusy);
    }
    if (this.pause && this.pauseLeft(start) > 0) {
      throw this.refusal(ERRORS.paused);
    }
    const readBy = Math.min(start + TIMINGS.commandReadMax, sendBy - TIMINGS.commandMinSend);
    // The fresh read: the device at its last known position, never the values in memory.
    let fresh;
    try {
      fresh = await client.device(entry.index, { deadline: readBy });
    } catch (err) {
      if (!(err instanceof TouchlineError)) {
        throw err;
      }
      if (err.code === 'late' || err.code === 'timeout') {
        throw this.lateError(ahead, roundBusy || Boolean(this.running));
      }
      throw this.refusal(ERRORS.unknownState(reasonOf(err)));
    }
    if (generation !== this.generation) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (fresh === undefined) {
      throw this.refusal(ERRORS.noDeviceAtPosition);
    }
    if (platformId(fresh) !== key) {
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
            throw this.lateError(ahead, roundBusy);
          }
        },
        onSent: () => {
          // The request really left: from now on, never "not sent".
          left = true;
          const at = this.monotonic();
          this.writtenAt.set(key, at);
          this.pendingWrites.set(key, {
            role: target.role,
            expected: value,
            checks: 1 + TIMINGS.followUps.length,
          });
        },
      });
    } catch (err) {
      if (left) {
        this.afterWrite(generation, entry.index, key);
      }
      if (!(err instanceof TouchlineError)) {
        throw err;
      }
      if (!left || !err.sent) {
        if (err.code === 'late') {
          throw this.lateError(ahead, roundBusy);
        }
        throw this.refusal(ERRORS.notSent(reasonOf(err)));
      }
      if (err.code === 'http' && err.status && err.status >= 400 && err.status < 500) {
        throw this.refusal(ERRORS.refusedByController);
      }
      // The request may have reached the controller: never "not sent".
      throw this.refusal(ERRORS.unconfirmed);
    }
    this.afterWrite(generation, entry.index, key);
    // The echo came: the value is read back within the ack when there is time, and compared.
    const echoed = this.monotonic();
    if (echoed <= received + TIMINGS.commandConfirmBy) {
      let check;
      try {
        check = await client.device(entry.index, { deadline: answerBy });
      } catch {
        check = undefined;
      }
      if (generation === this.generation && check && platformId(check) === key) {
        const result = this.storeRead(key, check, echoed);
        if (result === 'applied') {
          await this.refreshStatus();
          return undefined;
        }
        if (result === 'not_applied') {
          await this.refreshStatus();
          throw this.refusal(
            ERRORS.notAppliedNow(
              describe(target.role, readValueOf(target.role, check)),
              describe(target.role, value),
            ),
          );
        }
      }
    }
    throw this.refusal(ERRORS.verifyLater);
  }

  /**
   * A read of a device after a write: compared with the value written when
   * the read started after the write left. 'applied', 'not_applied', or
   * undefined (no write to check). A write the reads contradict is told
   * (log, status, badge) until a read shows it, or until the next read once
   * its checks are spent.
   */
  checkWrite(key, device, at) {
    const pending = this.pendingWrites.get(key);
    if (!pending || at < (this.writtenAt.get(key) ?? -Infinity)) {
      if (!pending) {
        this.warnings.delete(key);
      }
      return undefined;
    }
    const read = readValueOf(pending.role, device);
    if (read === pending.expected) {
      this.pendingWrites.delete(key);
      this.warnings.delete(key);
      return 'applied';
    }
    pending.checks -= 1;
    if (pending.checks <= 0) {
      this.pendingWrites.delete(key);
    }
    const text = (language) =>
      `${word(deviceName(device.name, device.index), language)}${language === 'fr' ? ' : ' : ': '}${
        describe(pending.role, read)[language]
      } ≠ ${describe(pending.role, pending.expected)[language]}`;
    if (!this.warnings.has(key)) {
      this.logger.warn(
        `roth-touchline: the command on ${key} did not take effect (read ${read}, written ${pending.expected})`,
      );
    }
    this.warnings.set(key, both(text('en'), text('fr')));
    return 'not_applied';
  }

  /** A device read outside a round (a check after a write): its states, its write checked. */
  storeRead(key, device, at) {
    const result = this.checkWrite(key, device, at);
    if (at >= (this.writtenAt.get(key) ?? -Infinity)) {
      const entry = this.devices.get(key);
      if (entry) {
        entry.device = device;
        entry.at = at;
      }
      this.queueStates(device);
    }
    return result;
  }

  /** The status and the badges again, after a check of a write. */
  async refreshStatus() {
    if (this.round && !this.offline) {
      await this.setStatus(true, this.statusMessage());
    }
    await this.publishBadges();
    await this.flush();
  }

  /** After a write that left: the write dated in /data, the device read again 5 s and 20 s later. */
  afterWrite(generation, index, key) {
    this.lastWriteAt = this.monotonic();
    this.persist(this.lastWriteAt).catch(() => {});
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

  /**
   * One device read again after a command: never skipped (it waits its turn
   * behind a round request or a command); its states and the check of the
   * write, when its ids are still the target's.
   */
  async followUp(index, key) {
    const client = this.client;
    const generation = this.generation;
    if (!client) {
      return;
    }
    await this.commandsIdle();
    if (generation !== this.generation) {
      return;
    }
    const at = this.monotonic();
    const device = await client.device(index, { deadline: at + TIMINGS.requestTimeout });
    if (generation !== this.generation || device === undefined || platformId(device) !== key) {
      return;
    }
    this.storeRead(key, device, at);
    await this.refreshStatus();
  }
}
