// -----------------------------------------------------------------------------
// The Gladys devices: units of the core only, string options, ids frozen,
// no switch, features of a created device kept.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  COMMAND_ROLES,
  ROLES,
  buildDevice,
  deviceStates,
  keepCreatedFeatures,
  modeOptions,
  parseDeviceId,
  parseFeatureId,
  programOptions,
} from '../src/devices.js';
import { created } from './helpers/app.js';

const CORE = '/home/claude/code/Gladys/server/utils/constants.js';
const core = existsSync(CORE) ? createRequire(import.meta.url)(CORE) : undefined;
const CORE_NORMALIZE = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
const normalizeSupportedOptions = existsSync(CORE_NORMALIZE)
  ? createRequire(import.meta.url)(CORE_NORMALIZE).normalizeSupportedOptions
  : undefined;

test('a device: ids from the controller ids, four features, units of the core, no switch', () => {
  const device = created({ name: 'Salon' });
  assert.equal(device.external_id, 'ext:roth:touchline:100-1');
  assert.equal(device.name, 'Salon (Touchline)');
  assert.equal(device.should_poll, false);
  assert.deepEqual(
    device.features.map((f) => f.external_id),
    ROLES.map((r) => `ext:roth:touchline:100-1:${r}`),
  );
  const byRole = Object.fromEntries(
    device.features.map((f) => [f.external_id.split(':').at(-1), f]),
  );
  assert.equal(byRole.temperature.category, 'temperature-sensor');
  assert.equal(byRole.temperature.unit, 'celsius');
  assert.equal(byRole.temperature.read_only, true);
  assert.equal(byRole['target-temperature'].category, 'thermostat');
  assert.equal(byRole['target-temperature'].type, 'target-temperature');
  assert.equal(byRole['target-temperature'].min, 5);
  assert.equal(byRole['target-temperature'].max, 30);
  assert.equal(byRole.mode.category, 'text');
  assert.equal(byRole.mode.type, 'select');
  for (const f of device.features) {
    assert.notEqual(f.category, 'switch', f.external_id);
    assert.ok(
      !(f.type === 'binary' && f.read_only === false),
      `${f.external_id} is a writable binary`,
    );
  }
  assert.deepEqual(device.params, [
    { name: 'controller_id', value: '100' },
    { name: 'device_id', value: '1' },
    { name: 'position', value: 'G0' },
  ]);
  assert.equal(created({}, { language: 'en' }).features[0].name, 'Temperature');
  if (core) {
    const units = core.DEVICE_FEATURE_UNITS_BY_CATEGORY;
    for (const f of device.features) {
      if (f.unit) {
        assert.ok(
          units[f.category]?.includes(f.unit),
          `${f.category}/${f.unit} is not a unit of the core`,
        );
      }
      assert.ok(Object.values(core.DEVICE_FEATURE_CATEGORIES).includes(f.category), f.category);
      const known = Object.values(core.DEVICE_FEATURE_TYPES).some((group) =>
        Object.values(group).includes(f.type),
      );
      assert.ok(known, `${f.category}/${f.type}`);
    }
  }
});

test('the select options: string values and labels, no duplicate, accepted by the core', () => {
  for (const options of [modeOptions('fr'), programOptions('en'), modeOptions('en')]) {
    for (const option of options) {
      assert.equal(typeof option.label, 'string');
      assert.ok(option.label.trim().length > 0);
      assert.equal(typeof option.value, 'string');
      assert.ok(Number.isInteger(option.sort_order));
    }
    assert.equal(new Set(options.map((o) => o.value)).size, options.length);
    if (normalizeSupportedOptions) {
      assert.deepEqual(normalizeSupportedOptions(options, { allowStringValues: true }), options);
    }
  }
  assert.equal(modeOptions('fr')[1].label, 'Nuit');
  assert.equal(programOptions('en')[0].value, 'none');
  const device = created();
  const mode = device.features.find((f) => f.external_id.endsWith(':mode'));
  assert.deepEqual(
    mode.supported_options.map((o) => o.value),
    ['normal', 'night', 'holiday'],
  );
});

test('ids: parsed back, foreign ids refused', () => {
  assert.deepEqual(parseDeviceId('ext:roth:touchline:100-1'), { owner: 100, id: 1 });
  assert.deepEqual(parseFeatureId('ext:roth:touchline:100-1:target-temperature'), {
    owner: 100,
    id: 1,
    role: 'target-temperature',
  });
  assert.equal(parseFeatureId('ext:roth:touchline:100-1:unknown'), undefined);
  assert.equal(parseFeatureId('ext:roth:other:100-1:mode'), undefined);
  assert.equal(parseDeviceId('ext:roth:touchline:100-1:mode'), undefined);
  assert.equal(parseFeatureId(undefined), undefined);
  assert.deepEqual(COMMAND_ROLES, ['target-temperature', 'mode', 'program']);
});

test('states: only the values read; unknown mode or program codes publish nothing', () => {
  const states = (over) => {
    const device = created(over);
    void device;
    return deviceStates(
      Object.assign(
        { temperatureTenths: 215, targetTenths: 220, modeCode: 0, programCode: 0 },
        over,
      ),
    );
  };
  assert.deepEqual(states({}), [
    ['temperature', { state: 21.5 }],
    ['target-temperature', { state: 22 }],
    ['mode', { text: 'normal' }],
    ['program', { text: 'none' }],
  ]);
  assert.deepEqual(states({ temperatureTenths: undefined, modeCode: 7, programCode: 3 }), [
    ['target-temperature', { state: 22 }],
    ['program', { text: 'program-3' }],
  ]);
});

test('a created device keeps its name and the features the new build lacks', () => {
  const gladys = createFakeGladys({ selector: 'roth' });
  const old = {
    name: 'Mon salon',
    external_id: 'ext:roth:touchline:100-1',
    features: [
      {
        name: 'Old',
        external_id: 'ext:roth:touchline:100-1:old',
        category: 'unknown',
        type: 'decimal',
        min: 0,
        max: 1,
        read_only: true,
        id: 'db-id',
        device_id: 'x',
      },
    ],
  };
  const built = buildDevice(
    gladys,
    { owner: 100, id: 1 },
    { device: undefined, language: 'fr', created: old },
  );
  assert.equal(built.name, 'Mon salon');
  assert.equal(built.features.length, ROLES.length + 1);
  const kept = built.features.at(-1);
  assert.deepEqual(kept, {
    name: 'Old',
    external_id: 'ext:roth:touchline:100-1:old',
    category: 'unknown',
    type: 'decimal',
    min: 0,
    max: 1,
    read_only: true,
  });
  assert.equal(built.params.length, 2, 'no position when not read now');
  assert.equal(keepCreatedFeatures(built, undefined), built);
});
