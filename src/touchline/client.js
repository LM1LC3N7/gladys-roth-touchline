// -----------------------------------------------------------------------------
// The client of one controller: the number of devices, one device, a write.
// One request at a time per client (the CGI is slow and single-threaded in
// practice); every request has a deadline on the monotonic clock.
//
// A write (`GET /cgi-bin/writeVal.cgi?G<i>.<parameter>=<value>`) is confirmed
// by the echo of the value in the answer, as the reference checks it. A
// write whose request may have left without a readable answer is reported
// `sent: true`, so the app never tells "not sent".
//
// Ported in part from pytouchline_extended 1.1.2 (MIT), changed: see
// THIRD_PARTY_NOTICES.md.
// -----------------------------------------------------------------------------

import { API, TIMINGS } from '../constants.js';
import { TouchlineError, request } from './http.js';
import { deviceItems, parseCount, parseDevice } from './model.js';
import { parseAnswer, readRequest } from './xml.js';

const PARAMETER = /^[A-Za-z]{1,24}$/;

export class TouchlineClient {
  constructor({ host, port, transport = request, monotonic = () => performance.now() }) {
    this.host = host;
    this.port = port;
    this.transport = transport;
    this.monotonic = monotonic;
    /** The requests one after the other: the next waits for the previous one to end. */
    this.chain = Promise.resolve();
  }

  /** One request at a time: a request asked during another waits for it (its deadline still holds). */
  send(options, { deadline, beforeSend, onSent } = {}) {
    const run = this.chain.then(async () => {
      const { status, body } = await this.transport(
        { hostname: this.host, port: this.port, ...options },
        { monotonic: this.monotonic, deadline, beforeSend, onSent },
      );
      if (status !== 200) {
        throw new TouchlineError('http', 'unexpected answer', { status, sent: true });
      }
      return body;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  async read(names, { deadline } = {}) {
    const body = await this.send(
      { method: 'POST', path: API.readPath, body: readRequest(names) },
      { deadline: deadline ?? this.monotonic() + TIMINGS.requestTimeout },
    );
    return parseAnswer(body);
  }

  /** The number of devices the controller knows (capped). */
  async count(options) {
    const count = parseCount(await this.read([API.countItem], options));
    if (count === undefined) {
      throw new TouchlineError('bad_response', 'the number of devices is unreadable', {
        sent: true,
      });
    }
    return count;
  }

  /** The device `G<index>`; undefined when the controller answers none of its items. */
  async device(index, options) {
    return parseDevice(await this.read(deviceItems(index), options), index);
  }

  /**
   * Writes `G<index>.<parameter>=<value>`; resolves when the controller
   * echoes the value, throws `unconfirmed` (sent) when it answers something
   * else. `value`: a non-negative integer, sent as the reference sends a
   * number (`2250.0` for a setpoint, `1` for a mode).
   */
  async write(index, parameter, value, { deadline, beforeSend, onSent, decimal = false } = {}) {
    if (!PARAMETER.test(parameter) || !Number.isInteger(index) || index < 0) {
      throw new TouchlineError('bad_request', 'invalid write');
    }
    if (!Number.isInteger(value) || value < 0) {
      throw new TouchlineError('bad_request', 'invalid value');
    }
    const text = decimal ? `${value}.0` : `${value}`;
    const body = await this.send(
      { method: 'GET', path: `${API.writePath}?G${index}.${parameter}=${text}` },
      { deadline: deadline ?? this.monotonic() + TIMINGS.requestTimeout, beforeSend, onSent },
    );
    const echo = Buffer.from(body ?? [])
      .toString('latin1')
      .trim();
    if (echo !== text && echo !== `${value}` && echo !== `${value}.0`) {
      throw new TouchlineError('unconfirmed', 'the controller did not echo the value', {
        sent: true,
      });
    }
  }
}
