// -----------------------------------------------------------------------------
// The XML of the controller: the request built, the answers read as untrusted
// data (bounded, linear), the values checked (model).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API, LIMITS } from '../src/constants.js';
import {
  deviceItems,
  integerOf,
  nameOf,
  parseCount,
  parseDevice,
  platformId,
  tenthsOf,
} from '../src/touchline/model.js';
import { decodeBody, decodeEntities, parseAnswer, readRequest } from '../src/touchline/xml.js';
import { DEVICE, answerFor } from './helpers/fakeController.js';

test('readRequest: the shape of the reference, this integration as the client, never upass', () => {
  const request = readRequest(deviceItems(2));
  assert.ok(request.startsWith('<body><version>1.0</version>'));
  assert.ok(request.includes(`<client>${API.client}</client>`));
  assert.doesNotMatch(request, /IMaster/, 'never the identification of the Roth software');
  assert.ok(request.includes('<file_name>room</file_name><item_list_size>0</item_list_size>'));
  assert.ok(request.includes('<item_list><i><n>G2.name</n><n>G2.SollTempMaxVal</n>'));
  assert.ok(request.includes('<n>G2.ownerKurzID</n></i></item_list></body>'));
  assert.doesNotMatch(request, /upass/);
  assert.throws(() => readRequest(['<x>']), /invalid item name/);
});

test('parseAnswer: the name/value pairs, entities decoded, values cut', () => {
  const values = parseAnswer(
    Buffer.from(answerFor(deviceItems(0), [DEVICE({ name: 'Salle & bain <été>' })]), 'utf8'),
  );
  assert.equal(values.get('G0.name'), 'Salle & bain <été>');
  assert.equal(decodeEntities('&#233;t&#xE9; &amp;'), 'été &');
  assert.equal(values.get('G0.SollTemp'), '2200');
  assert.equal(values.size, 9);
  const long = parseAnswer(
    `<body><item_list><i><n>G0.name</n><v>${'x'.repeat(1000)}</v></i></item_list></body>`,
  );
  assert.equal(long.get('G0.name').length, 256);
});

test('parseAnswer: Latin-1 names are read, UTF-8 ones too', () => {
  const latin = Buffer.from(
    '<body><item_list><i><n>G0.name</n><v>Entr\xe9e</v></i></item_list></body>',
    'latin1',
  );
  assert.equal(parseAnswer(latin).get('G0.name'), 'Entrée');
  const utf8 = Buffer.from(
    '<body><item_list><i><n>G0.name</n><v>Entrée</v></i></item_list></body>',
    'utf8',
  );
  assert.equal(parseAnswer(utf8).get('G0.name'), 'Entrée');
  assert.equal(decodeBody(Buffer.from([0xff, 0xfe])), 'ÿþ');
  assert.equal(decodeEntities('&unknown; &#0; &#x110000;'), '&unknown; &#0; &#x110000;');
});

test('parseAnswer: refuses what is not an answer, bounded in items', () => {
  assert.throws(() => parseAnswer(Buffer.from('')), /empty/);
  assert.throws(() => parseAnswer(Buffer.from('<html>nope</html>')), /no item list/);
  assert.throws(
    () => parseAnswer('<body><item_list><i><n>G0.name</n></i></item_list></body>'),
    /no value/,
  );
  assert.throws(
    () =>
      parseAnswer('<body><item_list><i><n>G0.name</n><n>G0.x</n><v>1</v></i></item_list></body>'),
    /no value/,
  );
  assert.throws(
    () => parseAnswer('<body><item_list><i><n>bad name!</n><v>1</v></i></item_list></body>'),
    /unexpected item name/,
  );
  const many = Array.from({ length: LIMITS.items + 1 }, (_, i) => `<n>G${i}.name</n><v>x</v>`).join(
    '',
  );
  assert.throws(
    () => parseAnswer(`<body><item_list><i>${many}</i></item_list></body>`),
    /too many/,
  );
  // A value holding tags is read as text, never as items.
  const nested = parseAnswer(
    '<body><item_list><i><n>G0.name</n><v>a &lt;n&gt;b&lt;/n&gt;</v></i></item_list></body>',
  );
  assert.equal(nested.get('G0.name'), 'a <n>b</n>');
});

test('model: integers strictly, temperatures plausible, names printable', () => {
  assert.equal(integerOf('2200'), 2200);
  assert.equal(integerOf(' -5 '), -5);
  assert.equal(integerOf(''), undefined, "'' is not 0");
  assert.equal(integerOf('NA'), undefined);
  assert.equal(integerOf('22.5'), undefined);
  assert.equal(integerOf(undefined), undefined);
  assert.equal(tenthsOf('2150'), 215);
  assert.equal(tenthsOf('2155'), 216, 'rounded to tenths');
  assert.equal(tenthsOf('9000'), undefined, '90 °C is not a room temperature');
  assert.equal(tenthsOf('-5000'), undefined);
  assert.equal(nameOf('  Living\u0000 room '), 'Living  room');
  assert.equal(nameOf(''), undefined);
  assert.equal(nameOf('x'.repeat(100)).length, LIMITS.nameLength);
});

test('model: a device, its ids, the count capped', () => {
  const values = parseAnswer(
    answerFor(deviceItems(1), [undefined, DEVICE({ OPMode: '2', WeekProg: '3' })]),
  );
  const device = parseDevice(values, 1);
  assert.deepEqual(device, {
    index: 1,
    id: 1,
    owner: 100,
    name: 'Living room',
    temperatureTenths: 215,
    targetTenths: 220,
    minTenths: 50,
    maxTenths: 300,
    modeCode: 2,
    programCode: 3,
  });
  assert.equal(platformId(device), '100-1');
  assert.equal(parseDevice(values, 0), undefined, 'no item of G0 in the answer');
  const partial = parseDevice(parseAnswer(answerFor(['G0.name'], [DEVICE()])), 0);
  assert.equal(partial.name, 'Living room');
  assert.equal(partial.id, undefined);
  assert.equal(platformId(partial), undefined, 'incomplete ids: no platform id');
  const negative = parseDevice(
    new Map([
      ['G0.kurzID', '-1'],
      ['G0.ownerKurzID', '7'],
    ]),
    0,
  );
  assert.equal(negative.id, undefined);
  assert.equal(parseCount(parseAnswer(answerFor([API.countItem], [], { count: 3 }))), 3);
  assert.equal(
    parseCount(parseAnswer(answerFor([API.countItem], [], { count: 500 }))),
    LIMITS.devices,
  );
  assert.equal(parseCount(parseAnswer(answerFor([API.countItem], [], { count: 'NA' }))), undefined);
  assert.equal(parseCount(parseAnswer(answerFor([API.countItem], [], { count: -1 }))), undefined);
});
