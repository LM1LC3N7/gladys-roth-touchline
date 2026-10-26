// -----------------------------------------------------------------------------
// The client against the fake controller, and the HTTP transport against a
// real local server (bounded body, deadline, `sent`, beforeSend).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { TouchlineClient } from '../src/touchline/client.js';
import { TouchlineError, errorReason, networkError, request } from '../src/touchline/http.js';
import { DEVICE, fakeController } from './helpers/fakeController.js';

const client = (world, monotonic = () => performance.now()) =>
  new TouchlineClient({ host: '192.168.1.254', port: 80, transport: world.transport, monotonic });

test('count and device through the CGI; one request at a time, in order', async () => {
  const world = fakeController({ devices: [DEVICE(), DEVICE({ name: 'Bedroom', kurzID: '2' })] });
  const c = client(world);
  const [count, first, second] = await Promise.all([c.count(), c.device(0), c.device(1)]);
  assert.equal(count, 2);
  assert.equal(first.name, 'Living room');
  assert.equal(second.id, 2);
  assert.deepEqual(
    world.requests.map((r) => r.method),
    ['POST', 'POST', 'POST'],
  );
  assert.equal(world.requests[0].path, '/cgi-bin/ILRReadValues.cgi');
  assert.match(String(world.requests[0].body), /totalNumberOfDevices/);
  assert.equal(await c.device(5), undefined, 'a position the controller does not answer');
});

test('write: the echo confirms, 2250.0 for a setpoint, a plain integer for a mode', async () => {
  const world = fakeController();
  const c = client(world);
  await c.write(0, 'SollTemp', 2250, { decimal: true });
  assert.equal(world.requests.at(-1).path, '/cgi-bin/writeVal.cgi?G0.SollTemp=2250.0');
  assert.equal(world.devices[0].SollTemp, '2250');
  await c.write(0, 'OPMode', 1);
  assert.equal(world.requests.at(-1).path, '/cgi-bin/writeVal.cgi?G0.OPMode=1');
  world.noEcho.add('WeekProg');
  await assert.rejects(c.write(0, 'WeekProg', 2), (err) => err.code === 'unconfirmed' && err.sent);
  await assert.rejects(c.write(0, 'Soll Temp', 1), /invalid write/);
  await assert.rejects(c.write(0, 'SollTemp', 22.5), /invalid value/);
  await assert.rejects(c.write(0, 'SollTemp', -1), /invalid value/);
  await assert.rejects(
    c.write(9, 'SollTemp', 2200, { decimal: true }),
    (err) => err.code === 'http' && err.status === 404,
  );
});

test('errors: statuses, unreadable count, network reasons without the address', async () => {
  const world = fakeController();
  const c = client(world);
  world.queue.push({ status: 500, body: Buffer.from('boom') });
  await assert.rejects(c.count(), (err) => err.code === 'http' && err.status === 500 && err.sent);
  world.queue.push({
    status: 200,
    body: Buffer.from(
      '<body><item_list><i><n>totalNumberOfDevices</n><v>NA</v></i></item_list></body>',
    ),
  });
  await assert.rejects(c.count(), /unreadable/);
  world.failNetwork('ECONNREFUSED');
  await assert.rejects(c.count(), (err) => err.code === 'network' && err.reason === 'ECONNREFUSED');
  const err = networkError(
    Object.assign(new Error('connect ECONNREFUSED 192.168.1.254:80'), { code: 'ECONNREFUSED' }),
  );
  assert.equal(err.message, 'connection refused');
  assert.doesNotMatch(errorReason(err), /192\.168/);
  assert.equal(errorReason(new Error('x')), 'internal error');
  assert.equal(
    errorReason(new TouchlineError('http', 'unexpected answer', { status: 503 })),
    'unexpected answer (HTTP 503)',
  );
  assert.equal(networkError(new TouchlineError('late', 'x')).code, 'late');
});

test('http: a real local server; bounded body, deadline, sent, beforeSend', async () => {
  let slow;
  const server = createServer((req, res) => {
    if (req.url === '/big') {
      res.writeHead(200);
      res.end(Buffer.alloc(70 * 1024, 65));
      return;
    }
    if (req.url === '/slow') {
      slow = res;
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(`<echo>${req.method}:${req.headers['content-type'] ?? ''}:${body.length}</echo>`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const answer = await request({
      hostname: '127.0.0.1',
      port,
      method: 'POST',
      path: '/read',
      body: '<body/>',
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.toString(), '<echo>POST:text/xml:7</echo>');
    await assert.rejects(
      request({ hostname: '127.0.0.1', port, path: '/big' }),
      (err) => err.code === 'size' && err.sent,
    );
    const start = performance.now();
    await assert.rejects(
      request({ hostname: '127.0.0.1', port, path: '/slow' }, { deadline: start + 150 }),
      (err) => err.code === 'timeout' && err.sent === true,
    );
    slow?.end();
    await assert.rejects(
      request({ hostname: '127.0.0.1', port, path: '/read' }, { deadline: performance.now() - 1 }),
      (err) => err.code === 'late' && err.sent === false,
    );
    let refused = 0;
    await assert.rejects(
      request(
        { hostname: '127.0.0.1', port, path: '/read' },
        {
          beforeSend: () => {
            refused += 1;
            throw new TouchlineError('late', 'refused before the first byte');
          },
        },
      ),
      (err) => err.code === 'late' && err.sent === false,
    );
    assert.equal(refused, 1);
    await assert.rejects(
      request({ hostname: '127.0.0.1', port: 1, path: '/read' }),
      (err) => err.code === 'network' && err.sent === false,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
