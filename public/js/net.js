/* global io */
// Socket connection, the saved sign-in token, and server-provided config.

const TOKEN_KEY = 'mog:token';

export const token = {
  get() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(value) {
    try {
      localStorage.setItem(TOKEN_KEY, value);
    } catch {
      /* private mode: the profile only lasts for this tab */
    }
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  },
};

// `auth` as a function is re-read on every (re)connect, so a token saved
// after registering is picked up automatically.
export const socket = io({ autoConnect: false, auth: (cb) => cb({ token: token.get() }) });

/** Emit with an acknowledgement; never rejects. */
export function ask(event, payload = {}, timeoutMs = 15000) {
  return socket
    .timeout(timeoutMs)
    .emitWithAck(event, payload)
    .catch(() => ({ ok: false, error: 'timeout' }));
}

export const config = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
  maxMessageLength: 1000,
  maxInterests: 10,
  maxImageBytes: 1.5 * 1024 * 1024,
  avatars: {
    emojis: ['🦊', '🐼', '🐸', '🐙', '🦄', '🐯', '🐨', '🐵'],
    colors: ['#ff6b4a', '#ffb020', '#2ec27e', '#1fb6c9', '#3f7cff', '#8b5cf6', '#ec4899', '#64748b'],
  },
};

export async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) Object.assign(config, await res.json());
  } catch {
    /* use defaults */
  }
}

/** Small key/value storage that never throws. */
export const prefs = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`mog:${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`mog:${key}`, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
};
