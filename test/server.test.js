'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createServer, cleanMessage, cleanSignal } = require('../src/server');

const quiet = { info() {}, warn() {}, error() {} };

async function startServer(options = {}) {
  const server = createServer({ logger: quiet, fallbackMs: 200, ...options });
  const { port } = await server.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${port}`;
  const clients = [];
  return {
    server,
    url,
    async client() {
      const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
      clients.push(socket);
      await once(socket, 'connect');
      return socket;
    },
    async stop() {
      clients.forEach((c) => c.disconnect());
      await server.close();
    },
  };
}

function once(socket, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function never(socket, event, ms = 150) {
  return new Promise((resolve, reject) => {
    const handler = () => reject(new Error(`Unexpected "${event}"`));
    socket.once(event, handler);
    setTimeout(() => {
      socket.off(event, handler);
      resolve();
    }, ms);
  });
}

async function pair(ctx, opts = {}) {
  const a = await ctx.client();
  const b = await ctx.client();
  const aMatched = once(a, 'matched');
  const bMatched = once(b, 'matched');
  a.emit('find', { mode: 'text', seq: 1, ...opts });
  await once(a, 'searching');
  b.emit('find', { mode: 'text', seq: 7, ...opts });
  return { a, b, aInfo: await aMatched, bInfo: await bMatched };
}

test('cleanMessage strips control characters and enforces length', () => {
  assert.equal(cleanMessage('  hi\u0007 there  ', 100), 'hi there');
  assert.equal(cleanMessage('a\n\n\n\nb', 100), 'a\n\nb');
  assert.equal(cleanMessage('x'.repeat(50), 10), 'x'.repeat(10));
  assert.equal(cleanMessage(42, 10), '');
});

test('cleanSignal only passes known WebRTC fields', () => {
  assert.deepEqual(cleanSignal({ description: { type: 'offer', sdp: 'v=0', extra: 1 } }), {
    description: { type: 'offer', sdp: 'v=0' },
  });
  assert.equal(cleanSignal({ description: { type: 'rollback', sdp: '' } }), null);
  assert.deepEqual(cleanSignal({ candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0, junk: true } }), {
    candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null },
  });
  assert.equal(cleanSignal('nope'), null);
});

test('serves the page, config and health endpoints with security headers', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.stop());

  const page = await fetch(`${ctx.url}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /the mog/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-powered-by'), null);

  const cfg = await (await fetch(`${ctx.url}/api/config`)).json();
  assert.ok(Array.isArray(cfg.iceServers));
  assert.equal(cfg.maxMessageLength, 1000);

  assert.deepEqual(await (await fetch(`${ctx.url}/healthz`)).json(), { ok: true });
  const client = await fetch(`${ctx.url}/socket.io/socket.io.js`);
  assert.equal(client.status, 200);
});

test('pairs two strangers and relays messages and typing', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.stop());
  const { a, b, aInfo, bInfo } = await pair(ctx);

  assert.equal(aInfo.seq, 1);
  assert.equal(bInfo.seq, 7);
  assert.equal(aInfo.chatId, bInfo.chatId);
  assert.notEqual(aInfo.initiator, bInfo.initiator, 'exactly one side starts the WebRTC offer');

  const typing = once(b, 'typing');
  a.emit('typing', true);
  assert.equal(await typing, true);

  const got = once(b, 'message');
  const ack = await a.timeout(1000).emitWithAck('message', { text: '  hello <b>there</b>  ' });
  assert.deepEqual(ack, { ok: true, text: 'hello <b>there</b>' });
  assert.deepEqual(await got, { text: 'hello <b>there</b>' });
});

test('online count is sent on connect', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.stop());
  const a = await ctx.client();
  const counted = once(a, 'online');
  const b = connect(ctx.url, { transports: ['websocket'], forceNew: true, reconnection: false });
  t.after(() => b.disconnect());
  const firstForB = await once(b, 'online');
  assert.equal(firstForB, 2);
  assert.ok(typeof (await counted.catch(() => 2)) === 'number');
});

test('matches by shared interest and reports the common ones', async (t) => {
  const ctx = await startServer({ fallbackMs: 60_000 });
  t.after(() => ctx.stop());
  const loner = await ctx.client();
  const a = await ctx.client();
  const b = await ctx.client();

  loner.emit('find', { mode: 'text', interests: ['knitting'] });
  await once(loner, 'searching');
  a.emit('find', { mode: 'text', interests: ['Anime', 'chess'] });
  await once(a, 'searching');

  const matched = once(a, 'matched');
  b.emit('find', { mode: 'text', interests: ['chess', 'go'] });
  assert.deepEqual((await matched).common, ['chess']);
  await never(loner, 'matched');
});

test('falls back to a random stranger after the interest timeout', async (t) => {
  const ctx = await startServer({ fallbackMs: 100 });
  t.after(() => ctx.stop());
  const a = await ctx.client();
  const b = await ctx.client();
  a.emit('find', { mode: 'text', interests: ['obscure'] });
  await once(a, 'searching');
  const matched = once(a, 'matched');
  b.emit('find', { mode: 'text' });
  assert.deepEqual((await matched).common, []);
});

test('skipping notifies the partner and requeues the skipper', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.stop());
  const { a, b } = await pair(ctx);
  const left = once(b, 'partner_left');
  const searching = once(a, 'searching');
  a.emit('find', { mode: 'text', seq: 2 });
  await left;
  assert.equal((await searching).seq, 2);

  // Messages no longer reach the old partner.
  const res = await b.timeout(1000).emitWithAck('message', { text: 'still there?' });
  assert.deepEqual(res, { ok: false, error: 'not_connected' });
});

test('leave and disconnect both end the chat', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.stop());

  const first = await pair(ctx);
  const left1 = once(first.b, 'partner_left');
  first.a.emit('leave');
  await left1;

  const second = await pair(ctx);
  const left2 = once(second.a, 'partner_left');
  second.b.disconnect();
  await left2;
});

test('rate limits message floods', async (t) => {
  const ctx = await startServer({ messageBurst: 3, messageWindowMs: 10_000 });
  t.after(() => ctx.stop());
  const { a } = await pair(ctx);
  const results = [];
  for (let i = 0; i < 5; i += 1) {
    results.push(await a.timeout(1000).emitWithAck('message', { text: `m${i}` }));
  }
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, false, false]);
  assert.equal(results[4].error, 'rate_limited');
});

test('relays WebRTC signals only in video mode', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.stop());

  const text = await pair(ctx);
  text.a.emit('signal', { description: { type: 'offer', sdp: 'v=0' } });
  await never(text.b, 'signal');

  const video = await pair(ctx, { mode: 'video' });
  const got = once(video.b, 'signal');
  video.a.emit('signal', { candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } });
  assert.deepEqual(await got, {
    candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null },
  });
});

test('reporting disconnects, blocks the pair, and bans at the threshold', async (t) => {
  const ctx = await startServer({ reportThreshold: 1 });
  t.after(() => ctx.stop());
  const { a, b } = await pair(ctx);

  const left = once(b, 'partner_left');
  const banned = once(b, 'banned');
  const ack = await a.timeout(1000).emitWithAck('report', { reason: 'spam' });
  assert.deepEqual(ack, { ok: true });
  await left;
  assert.ok((await banned).remainingMs > 0);

  b.emit('find', { mode: 'text' });
  assert.ok((await once(b, 'banned')).remainingMs > 0);
});

test('reported strangers are not re-matched with their reporter', async (t) => {
  // Threshold high enough that nobody is banned.
  const ctx = await startServer({ reportThreshold: 99 });
  t.after(() => ctx.stop());
  const { a, b } = await pair(ctx);
  await a.timeout(1000).emitWithAck('report', { reason: 'other' });

  a.emit('find', { mode: 'text' });
  await once(a, 'searching');
  b.emit('find', { mode: 'text' });
  await once(b, 'searching');
  await never(a, 'matched');
  assert.equal(ctx.server.matchmaker.waitingCount('text'), 2);
});
