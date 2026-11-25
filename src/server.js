'use strict';

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const { Matchmaker, normalizeInterests, MODES, MAX_INTERESTS } = require('./matchmaker');
const { Moderation } = require('./moderation');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

const DEFAULTS = {
  fallbackMs: 8000,
  maxMessageLength: 1000,
  messageBurst: 10,
  messageWindowMs: 5000,
  reportThreshold: 3,
  banMs: 60 * 60 * 1000,
  iceServers: DEFAULT_ICE_SERVERS,
  trustProxy: false,
  onlineBroadcastMs: 3000,
  logger: console,
};

const REPORT_REASONS = new Set(['spam', 'harassment', 'nudity', 'underage', 'other']);

function securityHeaders(req, res, next) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "media-src 'self' blob: mediastream:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  next();
}

/** Strip control characters (keeping newlines and tabs) and trim. */
function cleanMessage(text, maxLength) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

/** Only pass along the WebRTC fields the client actually needs. */
function cleanSignal(data) {
  if (!data || typeof data !== 'object') return null;
  const desc = data.description;
  if (desc && typeof desc === 'object') {
    if ((desc.type === 'offer' || desc.type === 'answer') && typeof desc.sdp === 'string') {
      return { description: { type: desc.type, sdp: desc.sdp } };
    }
    return null;
  }
  const cand = data.candidate;
  if (cand && typeof cand === 'object' && typeof cand.candidate === 'string') {
    return {
      candidate: {
        candidate: cand.candidate,
        sdpMid: typeof cand.sdpMid === 'string' ? cand.sdpMid : null,
        sdpMLineIndex: Number.isInteger(cand.sdpMLineIndex) ? cand.sdpMLineIndex : null,
        usernameFragment: typeof cand.usernameFragment === 'string' ? cand.usernameFragment : null,
      },
    };
  }
  return null;
}

function createServer(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const log = config.logger;

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);
  app.use(securityHeaders);

  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 64 * 1024 });

  const onlineCount = () => io.of('/').sockets.size;

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/api/config', (req, res) => {
    res.json({
      iceServers: config.iceServers,
      maxMessageLength: config.maxMessageLength,
      maxInterests: MAX_INTERESTS,
    });
  });
  app.get('/api/stats', (req, res) => {
    res.json({
      online: onlineCount(),
      waiting: { text: matchmaker.waitingCount('text'), video: matchmaker.waitingCount('video') },
    });
  });
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  const moderation = new Moderation({ threshold: config.reportThreshold, banMs: config.banMs });

  const getSocket = (id) => io.of('/').sockets.get(id);
  const getPartner = (socket) => {
    const id = socket.data.partnerId;
    if (!id) return null;
    const partner = getSocket(id);
    if (!partner || partner.data.partnerId !== socket.id) return null;
    return partner;
  };

  const matchmaker = new Matchmaker({
    fallbackMs: config.fallbackMs,
    canPair(aId, bId) {
      const a = getSocket(aId);
      const b = getSocket(bId);
      if (!a || !b) return false;
      return !a.data.blocked.has(bId) && !b.data.blocked.has(aId);
    },
    onMatch(arrivedId, waitingId, common, mode) {
      const arrived = getSocket(arrivedId);
      const waiting = getSocket(waitingId);
      const chatId = crypto.randomUUID();
      arrived.data.partnerId = waitingId;
      waiting.data.partnerId = arrivedId;
      // The person who was already waiting creates the WebRTC offer.
      arrived.emit('matched', { chatId, mode, common, initiator: false, seq: arrived.data.seq });
      waiting.emit('matched', { chatId, mode, common, initiator: true, seq: waiting.data.seq });
    },
  });

  function endChat(socket) {
    const partner = getPartner(socket);
    socket.data.partnerId = null;
    if (partner) {
      partner.data.partnerId = null;
      partner.emit('partner_left');
    }
  }

  function clientAddress(socket) {
    if (config.trustProxy) {
      const fwd = socket.handshake.headers['x-forwarded-for'];
      if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
    }
    return socket.handshake.address;
  }

  io.on('connection', (socket) => {
    socket.data = {
      ip: clientAddress(socket),
      partnerId: null,
      mode: null,
      blocked: new Set(),
      messageTimes: [],
      seq: 0,
    };
    socket.emit('online', onlineCount());

    socket.on('find', (payload) => {
      const opts = payload && typeof payload === 'object' ? payload : {};
      const banned = moderation.banRemaining(socket.data.ip);
      if (banned) {
        matchmaker.dequeue(socket.id);
        endChat(socket);
        socket.emit('banned', { remainingMs: banned });
        return;
      }
      endChat(socket);
      const mode = MODES.has(opts.mode) ? opts.mode : 'text';
      const interests = normalizeInterests(opts.interests);
      socket.data.mode = mode;
      // Echoed back so the client can ignore events from searches it abandoned.
      socket.data.seq = Number.isSafeInteger(opts.seq) ? opts.seq : 0;
      socket.emit('searching', { mode, interests, seq: socket.data.seq });
      matchmaker.enqueue(socket.id, {
        mode,
        interests,
        randomFallback: opts.randomFallback !== false,
      });
    });

    socket.on('leave', () => {
      matchmaker.dequeue(socket.id);
      endChat(socket);
    });

    socket.on('message', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const partner = getPartner(socket);
      if (!partner) return reply({ ok: false, error: 'not_connected' });

      const raw = payload && typeof payload === 'object' ? payload.text : payload;
      const text = cleanMessage(raw, config.maxMessageLength);
      if (!text) return reply({ ok: false, error: 'empty' });

      const now = Date.now();
      const times = socket.data.messageTimes.filter((t) => now - t < config.messageWindowMs);
      if (times.length >= config.messageBurst) {
        socket.data.messageTimes = times;
        return reply({ ok: false, error: 'rate_limited' });
      }
      times.push(now);
      socket.data.messageTimes = times;

      partner.emit('typing', false);
      partner.emit('message', { text });
      reply({ ok: true, text });
    });

    socket.on('typing', (isTyping) => {
      const partner = getPartner(socket);
      if (partner) partner.emit('typing', Boolean(isTyping));
    });

    socket.on('signal', (data) => {
      const partner = getPartner(socket);
      if (!partner || socket.data.mode !== 'video') return;
      const clean = cleanSignal(data);
      if (clean) partner.emit('signal', clean);
    });

    socket.on('report', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const partner = getPartner(socket);
      if (!partner) return reply({ ok: false, error: 'not_connected' });

      const reason = REPORT_REASONS.has(payload?.reason) ? payload.reason : 'other';
      socket.data.blocked.add(partner.id);
      const banned = moderation.report(partner.data.ip, socket.data.ip);
      log.info?.(`[report] reason=${reason} banned=${banned}`);

      endChat(socket);
      if (banned) {
        matchmaker.dequeue(partner.id);
        partner.emit('banned', { remainingMs: moderation.banRemaining(partner.data.ip) });
      }
      reply({ ok: true });
    });

    socket.on('disconnect', () => {
      matchmaker.dequeue(socket.id);
      endChat(socket);
    });
  });

  let lastBroadcast = -1;
  const broadcastTimer = setInterval(() => {
    const count = onlineCount();
    if (count !== lastBroadcast) {
      lastBroadcast = count;
      io.emit('online', count);
    }
  }, config.onlineBroadcastMs);
  broadcastTimer.unref();

  const pruneTimer = setInterval(() => moderation.prune(), 10 * 60 * 1000);
  pruneTimer.unref();

  function listen(port, host) {
    return new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, () => {
        httpServer.off('error', reject);
        resolve(httpServer.address());
      });
    });
  }

  function close() {
    clearInterval(broadcastTimer);
    clearInterval(pruneTimer);
    return new Promise((resolve) => io.close(() => resolve()));
  }

  return { app, httpServer, io, matchmaker, moderation, listen, close };
}

module.exports = { createServer, cleanMessage, cleanSignal, DEFAULT_ICE_SERVERS };
