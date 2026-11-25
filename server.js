'use strict';

const path = require('path');
const { createServer, DEFAULT_ICE_SERVERS } = require('./src/server');

function intFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function iceServersFromEnv() {
  if (!process.env.ICE_SERVERS) return DEFAULT_ICE_SERVERS;
  try {
    const parsed = JSON.parse(process.env.ICE_SERVERS);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  console.warn('ICE_SERVERS is not a valid JSON array; using the default STUN servers.');
  return DEFAULT_ICE_SERVERS;
}

const port = intFromEnv('PORT', 3000);
const host = process.env.HOST || '0.0.0.0';

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));

const server = createServer({
  dataDir,
  iceServers: iceServersFromEnv(),
  trustProxy: /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || ''),
  fallbackMs: intFromEnv('INTEREST_FALLBACK_MS', 8000),
  reportThreshold: Math.max(1, intFromEnv('REPORT_THRESHOLD', 3)),
  banMs: intFromEnv('BAN_MINUTES', 60) * 60 * 1000,
});

server
  .listen(port, host)
  .then(() => {
    console.log(`the mog is running at http://localhost:${port}`);
    console.log(`Saving accounts and snaps in ${dataDir}`);
  })
  .catch((err) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });

function shutdown() {
  server.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
