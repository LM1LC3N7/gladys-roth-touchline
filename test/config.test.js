import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  controllerKey,
  isComplete,
  normalizeConfig,
  parseAddress,
} from '../src/config.js';

test('parseAddress: IP, host name, port, http prefix; refuses path, https, junk', () => {
  assert.deepEqual(parseAddress('192.168.1.254'), { host: '192.168.1.254', port: 80 });
  assert.deepEqual(parseAddress(' http://touchline.local:8080/ '), {
    host: 'touchline.local',
    port: 8080,
  });
  assert.deepEqual(parseAddress('[fe80::1]:81'), { host: 'fe80::1', port: 81 });
  assert.deepEqual(parseAddress('fe80::1'), { host: 'fe80::1', port: 80 });
  assert.deepEqual(parseAddress(''), {});
  assert.deepEqual(parseAddress('https://192.168.1.254'), { error: 'https' });
  assert.deepEqual(parseAddress('192.168.1.254/cgi-bin'), { error: 'path' });
  assert.deepEqual(parseAddress('admin:pw@192.168.1.254'), { error: 'path' });
  assert.deepEqual(parseAddress('not a host'), { error: 'path' });
  assert.deepEqual(parseAddress('a:b:c'), { error: 'invalid' });
  assert.deepEqual(parseAddress('host:0'), { error: 'invalid' });
  assert.deepEqual(parseAddress('-bad-'), { error: 'invalid' });
});

test('normalizeConfig: defaults, flags, clamps, key without the address in clear', () => {
  const config = normalizeConfig({});
  assert.equal(config.host, '');
  assert.equal(isComplete(config), false);
  assert.equal(config.allowSetpoints, DEFAULTS.allow_setpoints);
  assert.equal(config.allowModes, DEFAULTS.allow_modes);
  assert.equal(config.ceiling, 24);
  assert.equal(config.pollInterval, 60);
  assert.equal(config.language, 'fr');

  const full = normalizeConfig({
    host: '192.168.1.254',
    allow_setpoints: 'true',
    allow_modes: true,
    max_setpoint: '35',
    poll_interval: 5,
    language: 'EN',
  });
  assert.equal(isComplete(full), true);
  assert.equal(full.allowSetpoints, true);
  assert.equal(full.allowModes, true);
  assert.equal(full.ceiling, 30, 'never above 30 °C');
  assert.equal(full.pollInterval, 30, 'never under 30 s');
  assert.equal(full.language, 'en');
  assert.equal(normalizeConfig({ max_setpoint: 10 }).ceiling, 16, 'never under 16 °C');
  assert.equal(normalizeConfig({ max_setpoint: '' }).ceiling, 24, "'' is not 0");
  assert.equal(normalizeConfig({ allow_setpoints: 'yes' }).allowSetpoints, false);
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
  assert.match(full.key, /^[0-9a-f]{32}$/);
  assert.notEqual(full.key, controllerKey('192.168.1.253', 80));
  assert.ok(!full.key.includes('192'));
  assert.equal(controllerKey('', 80), '');
});
