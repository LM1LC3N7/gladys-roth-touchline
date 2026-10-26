// -----------------------------------------------------------------------------
// A fake Roth Touchline controller behind the transport of the client (no
// network): it answers the XML read requests (the count, the items of each
// device) and the writes (an echo of the value, applied to the device), as
// pytouchline_extended 1.1.2 describes the CGI. It records every request.
// `world.devices`: the devices by position (G0, G1…), editable at any time.
// -----------------------------------------------------------------------------

import { TouchlineError } from '../../src/touchline/http.js';

export const DEVICE = (over = {}) => ({
  name: 'Living room',
  SollTempMaxVal: '3000',
  SollTempMinVal: '500',
  WeekProg: '0',
  OPMode: '0',
  SollTemp: '2200',
  RaumTemp: '2150',
  kurzID: '1',
  ownerKurzID: '100',
  ...over,
});

const escape = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The XML answer for the item names asked, from the devices. */
export function answerFor(names, devices, { count } = {}) {
  const items = [];
  for (const name of names) {
    if (name === 'totalNumberOfDevices') {
      items.push(`<n>${name}</n><v>${count ?? devices.length}</v>`);
      continue;
    }
    const match = /^G(\d+)\.(\w+)$/.exec(name);
    if (!match) {
      continue;
    }
    const device = devices[Number(match[1])];
    if (device && device[match[2]] !== undefined) {
      items.push(`<n>${name}</n><v>${escape(device[match[2]])}</v>`);
    }
  }
  return `<body><version>1.0</version><item_list_size>${items.length}</item_list_size><item_list><i>${items.join('')}</i></item_list></body>`;
}

export function fakeController({ devices = [DEVICE()] } = {}) {
  const world = {
    devices,
    requests: [],
    /** Answers to give first: { status, body } | an Error | a function (request) => answer. */
    queue: [],
    /** A real delay (ms) before each answer. */
    delay: 0,
    /** When set, every answer waits for `release()` (a slow controller the test frees). */
    held: undefined,
    /** Which writes to refuse ("no echo"): parameter names. */
    noEcho: new Set(),
    hold() {
      let release;
      world.held = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        world.held = undefined;
        release();
      };
    },
    transport: async (options, { deadline, monotonic, beforeSend } = {}) => {
      const at = monotonic?.() ?? 0;
      const record = { ...options, at, deadline, end: undefined };
      world.requests.push(record);
      if (deadline !== undefined && monotonic() >= deadline) {
        throw new TouchlineError('late', 'no time left to send');
      }
      beforeSend?.();
      if (world.delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, world.delay));
      }
      if (world.held) {
        await world.held;
        if (deadline !== undefined && monotonic() > deadline) {
          throw new TouchlineError('timeout', 'no answer in time', { sent: true });
        }
      }
      try {
        return await respond(world, options);
      } finally {
        record.end = monotonic?.() ?? 0;
      }
    },
    failNetwork(code = 'EHOSTUNREACH') {
      world.queue.push(new TouchlineError('network', 'host unreachable', { reason: code }));
    },
  };
  return world;
}

const ok = (text) => ({ status: 200, body: Buffer.from(text, 'utf8') });

async function respond(world, { method, path, body }) {
  let next = world.queue.shift();
  if (typeof next === 'function') {
    // A function answers itself, or returns undefined to let the default answer through.
    next = next({ method, path, body });
  }
  if (next instanceof Error) {
    throw next;
  }
  if (next) {
    return { status: 200, body: Buffer.alloc(0), ...next };
  }
  if (method === 'POST' && path === '/cgi-bin/ILRReadValues.cgi') {
    const names = [...String(body).matchAll(/<n>([^<]+)<\/n>/g)].map((m) => m[1]);
    return ok(answerFor(names, world.devices));
  }
  const write = /^\/cgi-bin\/writeVal\.cgi\?G(\d+)\.(\w+)=([\d.]+)$/.exec(path);
  if (method === 'GET' && write) {
    const device = world.devices[Number(write[1])];
    if (!device) {
      return { status: 404, body: Buffer.from('not found') };
    }
    if (world.noEcho.has(write[2])) {
      return ok('');
    }
    device[write[2]] = String(Math.round(Number(write[3])));
    return ok(write[3]);
  }
  return { status: 404, body: Buffer.from('not found') };
}
