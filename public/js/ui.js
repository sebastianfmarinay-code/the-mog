// DOM helpers, avatars, toasts, time formatting and an app-wide event bus.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Tiny element builder: h('button', { class: 'x', onclick }, 'Label', child)
 * Strings become text nodes, so user content is never parsed as HTML.
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/** Fill (or create) an avatar bubble for a user `{ avatar: { emoji, color } }`. */
export function paintAvatar(el, user) {
  const avatar = (user && user.avatar) || { emoji: '🙂', color: '#64748b' };
  el.textContent = avatar.emoji;
  el.style.setProperty('--avatar-bg', avatar.color);
  return el;
}

export function avatar(user, size = 'md', { online } = {}) {
  const el = h('span', { class: `avatar avatar--${size}`, 'aria-hidden': 'true' });
  paintAvatar(el, user);
  if (online !== undefined) el.append(h('span', { class: `avatar__dot${online ? ' is-online' : ''}` }));
  return el;
}

export function showError(el, message) {
  el.textContent = message || '';
  el.hidden = !message;
}

// ---------- toasts ----------

const MAX_TOASTS = 3;

/**
 * Show a short notice. Toasts with the same `key` replace each other (so a
 * burst of messages from one friend shows one toast, not a pile).
 */
export function toast(message, { action, onAction, timeout = 3500, tone, key } = {}) {
  const box = $('#toasts');
  if (key) [...box.children].filter((t) => t.dataset.key === key).forEach((t) => t.remove());
  while (box.children.length >= MAX_TOASTS) box.firstElementChild.remove();
  const el = h('div', { class: `toast${tone ? ` toast--${tone}` : ''}`, role: 'status' }, h('span', {}, message));
  if (key) el.dataset.key = key;
  if (action) {
    el.append(
      h('button', {
        class: 'toast__action',
        type: 'button',
        onclick: () => {
          el.remove();
          onAction?.();
        },
        text: action,
      }),
    );
  }
  box.append(el);
  requestAnimationFrame(() => el.classList.add('is-in'));
  setTimeout(() => {
    el.classList.remove('is-in');
    setTimeout(() => el.remove(), 300);
  }, timeout);
}

// ---------- time & text ----------

export function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const d = Math.round(hrs / 24);
  return `${d}d ago`;
}

export function plural(n, word, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`;
}

export function formatList(items, joiner = 'and') {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${joiner} ${items[items.length - 1]}`;
}

const ERRORS = {
  timeout: "The server didn't answer. Check your connection and try again.",
  rate_limited: "You're doing that too fast — wait a moment.",
  not_found: "Couldn't find anyone with that username.",
  self: "That's you!",
  already_friends: "You're already friends.",
  not_friends: "You're not friends anymore.",
  invalid: 'Usernames are 3–20 characters: letters, numbers, _ and .',
  taken: 'That username is taken — try another.',
  invalid_image: "That photo couldn't be sent. Try taking it again.",
  no_recipients: 'Pick at least one person to send it to.',
  gone: 'That snap has already disappeared.',
  not_connected: "You're not chatting with anyone right now.",
  auth: 'Your session expired. Reload the page.',
};

export function errorText(code) {
  return ERRORS[code] || 'Something went wrong. Try again.';
}

// ---------- event bus ----------

const target = new EventTarget();
export const bus = {
  on(type, fn) {
    const handler = (e) => fn(e.detail);
    target.addEventListener(type, handler);
    return () => target.removeEventListener(type, handler);
  },
  emit(type, detail) {
    target.dispatchEvent(new CustomEvent(type, { detail }));
  },
};

/** Grow a textarea with its content, up to a max height. */
export function autosize(el, max = 140) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight + 2, max)}px`;
}

export const isTouch = () => window.matchMedia('(pointer: coarse)').matches;
