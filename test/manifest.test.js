// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULTS, LANGUAGES } from '../src/config.js';
import { ACTIONS, POLL_INTERVAL, SETPOINT } from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) {
      yield* texts(entry, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('the store basics, the same version everywhere, no keywords nor countries yet', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-roth-touchline:${manifest.version}`);
  assert.equal(manifest.version, JSON.parse(read('package.json')).version);
  assert.equal(manifest.version, JSON.parse(read('package-lock.json')).version);
  assert.deepEqual(manifest.transports, ['local']);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.equal(manifest.keywords, undefined, 'keywords need gladys_version >= 5.3.0');
  assert.equal(manifest.countries, undefined, 'countries need gladys_version >= 5.3.0');
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    const flat = docs.replace(/\n>?\s*/g, ' ');
    assert.match(flat, /not affiliated with Roth|sans lien avec Roth/i);
    assert.match(
      flat,
      lang === 'en' ? /never tested with a real device/i : /jamais testé avec un vrai appareil/i,
    );
    assert.match(flat, /Touchline SL/, 'the cloud sibling is named as distinct');
    assert.match(flat, /off by default|désactivées par défaut/i);
    assert.doesNotMatch(flat, /encrypt|chiffr/i, `docs/${lang}.md: nothing is encrypted`);
    // Absolute claims about the commands are false sooner or later (lesson 29).
    assert.doesNotMatch(flat, /\b(never|jamais) (fails|échoue)/i);
  }
  for (const file of ['README.md', 'CHANGELOG.md', 'TODO.md', 'CLAUDE.md']) {
    assert.doesNotMatch(read(file), /encrypt|chiffr/i, `${file}: nothing is encrypted`);
  }
  assert.match(read('TODO.md'), /## Decisions/);
  assert.match(read('CHANGELOG.md'), /## \[Unreleased\]/);
});

test('the licenses ship with the image; LICENSE is the standard text, without a name', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.doesNotMatch(license, /Louis|lmilcent|LM1LC3N7|Milcent/i);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /brondum\/pytouchline/);
  assert.match(notices, /1\.1\.2/);
  assert.match(notices, /Copyright \(c\) 2017 abondoe/);
  assert.match(notices, /Permission is hereby granted, free of charge/);
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY .*LICENSE/);
  assert.match(dockerfile, /COPY .*THIRD_PARTY_NOTICES\.md/);
  assert.ok(existsSync(new URL('../cover.png', import.meta.url)));
  const png = readFileSync(new URL('../cover.png', import.meta.url));
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
});

test('the configuration matches the code; commands off by default; no secret field', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const key of Object.keys(fields)) {
    assert.doesNotMatch(key, /^gladys_/i, 'a gladys_ key is never received');
  }
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    LANGUAGES,
  );
  assert.equal(fields.host.type, 'string');
  assert.equal(fields.host.required, true);
  assert.equal(fields.allow_setpoints.default, false);
  assert.equal(fields.allow_modes.default, false);
  assert.deepEqual(
    [fields.max_setpoint.min, fields.max_setpoint.max, fields.max_setpoint.default],
    [SETPOINT.ceilingMin, SETPOINT.max, SETPOINT.ceilingDefault],
  );
  assert.deepEqual(
    [fields.poll_interval.min, fields.poll_interval.max, fields.poll_interval.default],
    [POLL_INTERVAL.min, POLL_INTERVAL.max, POLL_INTERVAL.default],
  );
  for (const field of manifest.config_schema) {
    assert.notEqual(field.type, 'secret', 'the controller has no password');
    if (field.placeholder !== undefined) {
      assert.equal(typeof field.placeholder, 'object', field.key);
    }
  }
  const intro = fields.intro;
  assert.equal(intro.type, 'section');
  for (const lang of ['en', 'fr']) {
    assert.ok(intro.description[lang].length <= 1000, `intro.${lang} over 1000 characters`);
    assert.match(
      intro.description[lang],
      /Never tested with a real device|Jamais testé avec un vrai appareil/,
    );
    assert.match(intro.description[lang], /Touchline SL/);
  }
  assert.ok(intro.links.length <= 5 && intro.links.every((l) => l.url.startsWith('https://')));
});

test('the keys of the manifest are the keys of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  for (const action of manifest.actions) {
    assert.ok(action.timeout_seconds >= 5 && action.timeout_seconds <= 120);
  }
  assert.equal(manifest.scene_triggers, undefined);
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
});
