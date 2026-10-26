// -----------------------------------------------------------------------------
// The XML of the controller, built and read without a parser dependency.
//
// A read request:
//   <body><version>1.0</version><client>…</client><client_ver>…</client_ver>
//   <file_name>room</file_name><item_list_size>0</item_list_size>
//   <item_list><i><n>G0.name</n><n>G0.SollTemp</n>…</i></item_list></body>
// An answer:
//   <body>…<item_list><i><n>G0.name</n><v>Living room</v><n>G0.SollTemp</n>
//   <v>2200</v>…</i></item_list></body>
//
// The answer is read once, linearly, as untrusted data: a bounded number of
// items, names made of the characters the controller uses, values cut to a
// bounded length, entities decoded. Anything else is "not the expected
// answer". Names of devices may come in Latin-1: a body that is not valid
// UTF-8 is read as Latin-1. `<v/>` is an empty value (unknown).
// -----------------------------------------------------------------------------

import { API, LIMITS } from '../constants.js';
import { TouchlineError } from './http.js';

const NAME = /^[A-Za-z0-9_.]{1,32}$/;
const MAX_VALUE = 256;

/** The XML read request for `names` (item names such as `G0.SollTemp`). */
export function readRequest(names) {
  const items = names.map((n) => {
    if (!NAME.test(n)) {
      throw new TouchlineError('bad_response', 'invalid item name');
    }
    return `<n>${n}</n>`;
  });
  return (
    '<body>' +
    `<version>1.0</version>` +
    `<client>${API.client}</client>` +
    `<client_ver>${API.clientVersion}</client_ver>` +
    '<file_name>room</file_name>' +
    '<item_list_size>0</item_list_size>' +
    `<item_list><i>${items.join('')}</i></item_list>` +
    '</body>'
  );
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML entities -> characters; an unknown entity is kept as is. */
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-z]{2,4});/g, (whole, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity] ?? whole;
  });
}

/** The bytes of an answer as text: UTF-8 when the bytes are valid UTF-8, Latin-1 otherwise. */
export function decodeBody(body) {
  const bytes = Buffer.from(body ?? []);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

/** The text of the first `<tag>…</tag>` after `from`, with its end, or undefined. */
function element(text, tag, from, to) {
  const open = text.indexOf(`<${tag}>`, from);
  if (open < 0 || open >= to) {
    return undefined;
  }
  const start = open + tag.length + 2;
  const close = text.indexOf(`</${tag}>`, start);
  if (close < 0 || close > to) {
    return undefined;
  }
  return { text: text.slice(start, close), start, end: close + tag.length + 3 };
}

/**
 * The `<n>`/`<v>` pairs of an answer: a Map name -> value (strings, values
 * trimmed and cut, entities decoded). Throws `bad_response` when the body
 * is not an answer of the controller, `too_many` beyond LIMITS.items.
 */
export function parseAnswer(body) {
  const text = decodeBody(body);
  if (text.trim() === '') {
    throw new TouchlineError('empty', 'empty answer', { sent: true });
  }
  const list = element(text, 'item_list', 0, text.length);
  if (!list) {
    throw new TouchlineError('bad_response', 'the answer has no item list', { sent: true });
  }
  const values = new Map();
  let at = list.start;
  let count = 0;
  for (;;) {
    const n = element(text, 'n', at, list.end);
    if (!n) {
      break;
    }
    // `<v/>` is an empty value (as Python's ElementTree reads it): unknown, not an error.
    const empty = text.indexOf('<v/>', n.end);
    const full = text.indexOf('<v>', n.end);
    const v =
      empty >= 0 && empty < list.end && (full < 0 || empty < full)
        ? { text: '', start: empty, end: empty + 4 }
        : element(text, 'v', n.end, list.end);
    if (!v) {
      throw new TouchlineError('bad_response', 'an item has no value', { sent: true });
    }
    // The value of the item must come before the next name.
    const nextName = text.indexOf('<n>', n.end);
    if (nextName >= 0 && nextName < v.start) {
      throw new TouchlineError('bad_response', 'an item has no value', { sent: true });
    }
    count += 1;
    if (count > LIMITS.items) {
      throw new TouchlineError('too_many', 'too many items in the answer', { sent: true });
    }
    const name = n.text.trim();
    if (!NAME.test(name)) {
      throw new TouchlineError('bad_response', 'unexpected item name', { sent: true });
    }
    values.set(name, decodeEntities(v.text.slice(0, MAX_VALUE).trim()));
    at = v.end;
  }
  return values;
}
