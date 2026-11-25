'use strict';

const { io: connect } = require('socket.io-client');
const { createServer } = require('../src/server');

const quiet = { info() {}, warn() {}, error() {} };
const AVATAR = { emoji: '🦊', color: '#ff6b4a' };

let userCounter = 0;

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

const ask = (socket, event, payload = {}) => socket.timeout(2000).emitWithAck(event, payload);

async function startServer(options = {}) {
  const server = createServer({ logger: quiet, fallbackMs: 200, ...options });
  const { port } = await server.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${port}`;
  const clients = [];

  /**
   * Connect a socket. By default it registers a fresh account first, since
   * random chat needs a profile. Pass `{ register: false }` for a bare
   * socket, or `{ token }` to sign back in.
   */
  async function client({ register = true, token, username } = {}) {
    const socket = connect(url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      autoConnect: false,
      auth: token ? { token } : {},
    });
    clients.push(socket);
    const session = once(socket, 'session');
    socket.connect();
    socket.session = await session;
    if (register && !token) {
      userCounter += 1;
      const res = await ask(socket, 'register', { username: username || `tester${userCounter}`, avatar: AVATAR });
      if (!res.ok) throw new Error(`register failed: ${res.error}`);
      socket.user = res.user;
      socket.token = res.token;
    } else if (socket.session.user) {
      socket.user = socket.session.user;
    }
    return socket;
  }

  return {
    server,
    url,
    client,
    async stop() {
      clients.forEach((c) => c.disconnect());
      await server.close();
    },
  };
}

/** Two registered strangers matched in a random chat. */
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

/** Two registered users who are friends. */
async function friends(ctx) {
  const a = await ctx.client();
  const b = await ctx.client();
  await ask(a, 'friend_request', { username: b.user.username });
  await ask(b, 'respond_request', { from: a.user.id, accept: true });
  return { a, b };
}

module.exports = { startServer, once, never, ask, pair, friends, AVATAR, connect };
