// -----------------------------------------------------------------------------
// The answers of the controller -> checked values (pure).
//
// A device `G<i>` (a room thermostat known to the controller) is read as the
// reference does: its name, its setpoint limits, its week program, its
// operating mode, its setpoint, its room temperature, its short id
// (`kurzID`) and the id of its controller (`ownerKurzID`). Temperatures come
// in hundredths of °C. A value that is not a plain integer is unknown
// (`undefined`): "" and "NA" are not 0.
// -----------------------------------------------------------------------------

import { API, LIMITS, MODES, PROGRAMS, TEMPERATURE_RANGE } from '../constants.js';

const INTEGER = /^-?\d{1,9}$/;

/** A plain integer, else undefined ('' and 'NA' are not 0). */
export function integerOf(text) {
  return typeof text === 'string' && INTEGER.test(text.trim()) ? Number(text.trim()) : undefined;
}

/** Hundredths of °C -> tenths of °C (what Gladys shows), within the plausible range, else undefined. */
export function tenthsOf(text) {
  const hundredths = integerOf(text);
  if (hundredths === undefined) {
    return undefined;
  }
  const celsius = hundredths / 100;
  if (celsius < TEMPERATURE_RANGE.min || celsius > TEMPERATURE_RANGE.max) {
    return undefined;
  }
  return Math.round(hundredths / 10);
}

/** A device name: printable, cut; undefined when empty. */
export function nameOf(text) {
  if (typeof text !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return clean === '' ? undefined : clean.slice(0, LIMITS.nameLength);
}

/** The option value of a mode code, else undefined. */
export const modeOf = (code) => MODES.find((m) => m.code === code)?.value;
export const programOf = (code) => PROGRAMS.find((p) => p.code === code)?.value;
export const modeCode = (value) => MODES.find((m) => m.value === value)?.code;
export const programCode = (value) => PROGRAMS.find((p) => p.value === value)?.code;

/** The item names of the device `G<index>`. */
export const deviceItems = (index) => API.parameters.map((p) => `G${index}.${p}`);

/**
 * The device `G<index>` of an answer (a Map name -> value), or undefined when
 * the answer has none of its items. `id` (kurzID) and `owner` (ownerKurzID)
 * identify it; the rest may be undefined.
 */
export function parseDevice(values, index) {
  const get = (parameter) => values.get(`G${index}.${parameter}`);
  if (API.parameters.every((p) => get(p) === undefined)) {
    return undefined;
  }
  const id = integerOf(get('kurzID'));
  const owner = integerOf(get('ownerKurzID'));
  return {
    index,
    id: id !== undefined && id >= 0 ? id : undefined,
    owner: owner !== undefined && owner >= 0 ? owner : undefined,
    name: nameOf(get('name')),
    temperatureTenths: tenthsOf(get('RaumTemp')),
    targetTenths: tenthsOf(get('SollTemp')),
    minTenths: tenthsOf(get('SollTempMinVal')),
    maxTenths: tenthsOf(get('SollTempMaxVal')),
    modeCode: integerOf(get('OPMode')),
    programCode: integerOf(get('WeekProg')),
  };
}

/** The number of devices of the answer to `totalNumberOfDevices`, capped; undefined when unreadable. */
export function parseCount(values) {
  const count = integerOf(values.get(API.countItem));
  if (count === undefined || count < 0) {
    return undefined;
  }
  return Math.min(count, LIMITS.devices);
}

/** The platform id of a device (`<owner>-<id>`), the key of its Gladys external ids; undefined when incomplete. */
export const platformId = (device) =>
  device?.id === undefined || device?.owner === undefined
    ? undefined
    : `${device.owner}-${device.id}`;
