// -----------------------------------------------------------------------------
// The only network access: one HTTP request to the controller (a POST of the
// XML read request, or a GET of a write), over node:http, and the errors it
// ends with. The body read is bounded, the whole request is bounded in time
// (`deadline`, an absolute instant on the monotonic clock passed in), and
// an error tells whether the request may have reached the controller
// (`sent`): a write that may have left is never told "not sent".
//
// The messages never hold the address: the reasons are the error codes only.
// -----------------------------------------------------------------------------

import http from 'node:http';
import { LIMITS, TIMINGS } from '../constants.js';

/**
 * A failed request. `code`:
 * - `no_config`: no address (nothing sent);
 * - `network`: no answer (socket error), `reason` from the error code;
 * - `timeout`: no answer in time;
 * - `late`: the deadline passed before the request left (nothing sent);
 * - `http`: an unexpected status (`status`);
 * - `size`, `empty`, `bad_response`: not the expected answer;
 * - `too_many`: the answer lists more items than ours can.
 * `sent`: the request may have reached the controller.
 */
export class TouchlineError extends Error {
  constructor(code, message, { status, reason, sent = false } = {}) {
    super(message);
    this.name = 'TouchlineError';
    this.code = code;
    this.status = status;
    this.reason = reason;
    this.sent = sent;
  }
}

const NETWORK_REASONS = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
  HPE_INVALID_CONSTANT: 'not an HTTP answer',
};

/** A socket error -> TouchlineError, from its code only: Node's own message holds the address. */
export function networkError(err, sent) {
  if (err instanceof TouchlineError) {
    return err;
  }
  const code = typeof err?.code === 'string' && /^[A-Z_]{1,32}$/.test(err.code) ? err.code : '';
  return new TouchlineError('network', NETWORK_REASONS[code] ?? 'network error', {
    reason: code || undefined,
    sent,
  });
}

/** A short reason for a log, never the address. */
export function errorReason(err) {
  if (err instanceof TouchlineError) {
    const details = [err.reason, err.status ? `HTTP ${err.status}` : undefined].filter(Boolean);
    return details.length > 0 ? `${err.message} (${details.join(', ')})` : err.message;
  }
  return 'internal error';
}

/**
 * One request; resolves `{ status, body }` (body: a Buffer) whatever the
 * status. `deadline`: the monotonic instant by which the answer must be in
 * (a request still waiting then fails `timeout`, `sent: true`); `beforeSend`
 * runs once the socket is connected, right before the request leaves: it
 * may throw to abort with nothing sent (`late`).
 */
export function request(
  { hostname, port, method = 'GET', path, body, headers = {} },
  {
    monotonic = () => performance.now(),
    deadline,
    maxBytes = LIMITS.responseBytes,
    beforeSend,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const due = deadline ?? monotonic() + TIMINGS.requestTimeout;
    let timer;
    let settled = false;
    let sent = false;
    let req;
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const wait = due - monotonic();
    if (wait <= 0) {
      settle(reject, new TouchlineError('late', 'no time left to send'));
      return;
    }
    try {
      req = http.request(
        {
          hostname,
          port,
          path,
          method,
          headers: {
            Connection: 'close',
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(body) }),
            ...headers,
          },
          agent: false,
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
              settle(reject, new TouchlineError('size', 'answer too large', { sent: true }));
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            settle(resolve, { status: res.statusCode, body: Buffer.concat(chunks) }),
          );
          res.on('error', (err) => settle(reject, networkError(err, true)));
          res.on('aborted', () =>
            settle(reject, new TouchlineError('network', 'answer cut short', { sent: true })),
          );
        },
      );
    } catch (err) {
      settle(reject, new TouchlineError('network', 'invalid address', { reason: err?.code }));
      return;
    }
    timer = setTimeout(() => {
      settle(
        reject,
        new TouchlineError('timeout', `no answer within ${Math.round(wait / 1000)} s`, { sent }),
      );
      req.destroy();
    }, wait);
    req.on('error', (err) => settle(reject, networkError(err, sent)));
    req.on('socket', (socket) => {
      const send = () => {
        if (settled) {
          return;
        }
        try {
          beforeSend?.();
        } catch (err) {
          settle(reject, err);
          req.destroy();
          return;
        }
        if (due - monotonic() <= 0) {
          settle(reject, new TouchlineError('late', 'no time left to send'));
          req.destroy();
          return;
        }
        sent = true;
        req.end(body);
      };
      if (socket.connecting) {
        socket.once('connect', send);
      } else {
        send();
      }
    });
  });
}
