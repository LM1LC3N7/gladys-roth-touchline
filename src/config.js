// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { API, POLL_INTERVAL, SETPOINT } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  allow_setpoints: false,
  allow_modes: false,
  max_setpoint: SETPOINT.ceilingDefault,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * The address typed by the user: `{ host, port }`, `{ error: 'path' }` when it
 * holds a path, a query or credentials (a pasted URL), `{ error: 'https' }`
 * for https (the controller answers over http on the local network),
 * `{ error: 'invalid' }` when it is no IP address nor host name, `{}` when
 * empty. "http://" and ":port" are accepted.
 */
export function parseAddress(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') {
    return {};
  }
  if (/^https:\/\//i.test(text)) {
    return { error: 'https' };
  }
  text = text.replace(/^http:\/\//i, '').replace(/\/$/, '');
  if (/[/?#@\s]/.test(text)) {
    return { error: 'path' };
  }
  let host = text;
  let port;
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(text);
  if (bracketed) {
    host = bracketed[1];
    port = bracketed[2];
  } else if (isIP(text) !== 6) {
    const withPort = /^([^:]+):(\d{1,5})$/.exec(text);
    if (withPort) {
      host = withPort[1];
      port = withPort[2];
    } else if (text.includes(':')) {
      return { error: 'invalid' };
    }
  }
  if (isIP(host) === 0 && !HOSTNAME.test(host)) {
    return { error: 'invalid' };
  }
  const portNumber = port === undefined ? API.defaultPort : Number(port);
  if (portNumber < 1 || portNumber > 65535) {
    return { error: 'invalid' };
  }
  return { host: host.toLowerCase(), port: portNumber };
}

/** The key of a controller in /data: a hash of its address and port. */
export const controllerKey = (host, port) =>
  host
    ? createHash('sha256')
        .update(`roth-touchline:${host}:${port}`, 'utf8')
        .digest('hex')
        .slice(0, 32)
    : '';

const number = (value) =>
  value === undefined || value === null || value === '' ? NaN : Number(value);

const clamp = (value, { min, max }, fallback) =>
  Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : fallback;

/** A boolean option: true only when the value is `true` or the text "true". */
const flag = (value, fallback) =>
  value === true || value === 'true'
    ? true
    : value === false || value === 'false'
      ? false
      : fallback;

export function normalizeConfig(raw = {}) {
  const address = parseAddress(raw?.host);
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  return {
    host: address.host ?? '',
    port: address.port ?? API.defaultPort,
    addressError: address.error,
    key: controllerKey(address.host, address.port ?? API.defaultPort),
    allowSetpoints: flag(raw?.allow_setpoints, DEFAULTS.allow_setpoints),
    allowModes: flag(raw?.allow_modes, DEFAULTS.allow_modes),
    ceiling: clamp(
      number(raw?.max_setpoint),
      { min: SETPOINT.ceilingMin, max: SETPOINT.max },
      DEFAULTS.max_setpoint,
    ),
    pollInterval: clamp(number(raw?.poll_interval), POLL_INTERVAL, DEFAULTS.poll_interval),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}

/** True when the address is complete and valid. */
export const isComplete = (config) => config.host !== '' && config.addressError === undefined;
