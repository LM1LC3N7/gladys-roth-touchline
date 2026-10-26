// -----------------------------------------------------------------------------
// The devices of the controller -> Gladys devices and states (pure).
//
// `ext:<selector>:touchline:<owner>-<id>`: one Gladys device per room
// thermostat, keyed by the id of its controller (`ownerKurzID`) and its own
// short id (`kurzID`), the two ids the controller reports; the position
// `G<i>` is not part of the id (it moves when a device is removed) and is
// checked again at every read and before every command. A device whose ids
// cannot be read is not published. The feature roles (the last part of the
// feature external ids) are published forever: never rename them.
//
// A device published again never loses a feature: those of the device
// already created in Gladys are kept as they are (the core would mark it
// `structure_changed`, and "Update" would delete the missing feature and its
// history).
//
// No switch, no writable binary: a "turn everything off" (Google Home,
// Alexa, HomeKit, MCP, `switch.*` scenes) must never reach the heating. The
// commands are the setpoint (`thermostat/target-temperature`), the mode and
// the week program (`text/select`), refused unless the configuration allows
// them (src/app.js).
//
// Units are those the core lists (DEVICE_FEATURE_UNITS_BY_CATEGORY): °C on
// `temperature-sensor` and `thermostat`.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { FEATURES as F, MODES, PROGRAMS, SETPOINT, TEMPERATURE_RANGE } from './constants.js';
import { FEATURE_NAMES, MODE_NAMES, PROGRAM_NAMES, deviceName, word } from './i18n.js';
import { modeOf, platformId, programOf } from './touchline/model.js';

const select = {
  category: C.TEXT,
  type: T.TEXT.SELECT,
  min: 0,
  max: 0,
  read_only: false,
  has_feedback: true,
  keep_history: false,
};

/** The features, by role. */
export function definitionOf(role) {
  switch (role) {
    case F.TEMPERATURE:
      return {
        category: C.TEMPERATURE_SENSOR,
        type: T.SENSOR.DECIMAL,
        unit: U.CELSIUS,
        min: TEMPERATURE_RANGE.min,
        max: TEMPERATURE_RANGE.max,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      };
    case F.TARGET:
      return {
        category: C.THERMOSTAT,
        type: T.THERMOSTAT.TARGET_TEMPERATURE,
        unit: U.CELSIUS,
        // The slider stops at the hard bounds; the limits of the device and the ceiling refuse within them.
        min: SETPOINT.min,
        max: SETPOINT.max,
        read_only: false,
        has_feedback: true,
        keep_history: true,
      };
    case F.MODE:
    case F.PROGRAM:
      return { ...select };
    default:
      throw new Error(`unknown role ${role}`);
  }
}

/** Display order. */
export const ROLES = [F.TEMPERATURE, F.TARGET, F.MODE, F.PROGRAM];
export const COMMAND_ROLES = [F.TARGET, F.MODE, F.PROGRAM];

/** The fields of a feature Gladys stores (what is kept of a created feature). */
const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

export const deviceIds = (gladys, device) => gladys.externalIds('touchline', platformId(device));

const KEY = /:touchline:(\d{1,9})-(\d{1,9})/;

/** The owner, the id and the role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = new RegExp(`${KEY.source}:([a-z-]{1,40})$`).exec(externalId);
  if (!match || !ROLES.includes(match[3])) {
    return undefined;
  }
  return { owner: Number(match[1]), id: Number(match[2]), role: match[3] };
}

/** The owner and the id of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  const match = new RegExp(`${KEY.source}$`).exec(String(externalId ?? ''));
  return match ? { owner: Number(match[1]), id: Number(match[2]) } : undefined;
}

/** The options of a select: string values, string labels (the core requires both), ordered. */
export const modeOptions = (language) =>
  MODES.map((m, i) => ({
    value: m.value,
    label: word(MODE_NAMES[m.value], language),
    sort_order: i,
  }));
export const programOptions = (language) =>
  PROGRAMS.map((p, i) => ({
    value: p.value,
    label: word(PROGRAM_NAMES[p.value], language),
    sort_order: i,
  }));

/**
 * The states of a device read: `[role, state]` pairs, only for the values
 * read (an unreadable value publishes nothing; a mode or program code
 * outside the known list publishes nothing for its select).
 */
export function deviceStates(device) {
  const states = [];
  if (device.temperatureTenths !== undefined) {
    states.push([F.TEMPERATURE, { state: device.temperatureTenths / 10 }]);
  }
  if (device.targetTenths !== undefined) {
    states.push([F.TARGET, { state: device.targetTenths / 10 }]);
  }
  const mode = modeOf(device.modeCode);
  if (mode !== undefined) {
    states.push([F.MODE, { text: mode }]);
  }
  const program = programOf(device.programCode);
  if (program !== undefined) {
    states.push([F.PROGRAM, { text: program }]);
  }
  return states;
}

/**
 * The Gladys device of a room thermostat. `device`: the last read (or
 * undefined for a created device not read now); `created`: the device
 * already created in Gladys, whose name and features are kept.
 */
export function buildDevice(gladys, { owner, id }, { device, language, created }) {
  const ids = deviceIds(gladys, { owner, id });
  const params = [
    { name: 'controller_id', value: String(owner) },
    { name: 'device_id', value: String(id) },
  ];
  if (device?.index !== undefined) {
    params.push({ name: 'position', value: `G${device.index}` });
  }
  const built = {
    name: created?.name ?? word(deviceName(device?.name, device?.index ?? 0), language),
    external_id: ids.device,
    model: 'Roth Touchline',
    should_poll: false,
    features: ROLES.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...definitionOf(role),
      ...(role === F.MODE ? { supported_options: modeOptions(language) } : {}),
      ...(role === F.PROGRAM ? { supported_options: programOptions(language) } : {}),
    })),
    params,
  };
  return keepCreatedFeatures(built, created);
}

/** The features of the created device that the new build lacks, kept as they are. */
export function keepCreatedFeatures(built, created) {
  if (!created) {
    return built;
  }
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => typeof f?.external_id === 'string' && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  return { ...built, features: [...built.features, ...kept] };
}
