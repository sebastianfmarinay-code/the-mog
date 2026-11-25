// Full-screen viewer for disappearing snaps and stories.

import { ask } from './net.js';
import { $, h, paintAvatar, timeAgo, toast, errorText, plural, formatList } from './ui.js';

const STORY_MS = 5000;

const els = {};
let session = null; // the thing currently on screen

function init() {
  if (els.root) return;
  Object.assign(els, {
    root: $('#viewer'),
    bars: $('#viewer-bars'),
    avatar: $('#viewer-avatar'),
    name: $('#viewer-name'),
    time: $('#viewer-time'),
    ring: $('#viewer-ring'),
    close: $('#viewer-close'),
    loading: $('#viewer-loading'),
    img: $('#viewer-img'),
    tap: $('#viewer-tap'),
    foot: $('#viewer-foot'),
  });
  els.close.addEventListener('click', () => session?.close());
  document.addEventListener('keydown', (e) => {
    if (!session) return;
    if (e.key === 'Escape') session.close();
    else if (e.key === 'ArrowRight' || e.key === ' ') session.next?.();
    else if (e.key === 'ArrowLeft') session.prev?.();
  });
  els.root.addEventListener('contextmenu', (e) => e.preventDefault());

  // Tap right/left to move; press and hold to pause (stories).
  let downAt = 0;
  els.tap.addEventListener('pointerdown', () => {
    downAt = performance.now();
    session?.pause?.(true);
  });
  els.tap.addEventListener('pointerup', (e) => {
    session?.pause?.(false);
    if (performance.now() - downAt > 300) return; // that was a hold
    const rect = els.tap.getBoundingClientRect();
    if (e.clientX - rect.left < rect.width * 0.3) session?.prev?.();
    else session?.next?.();
  });
  els.tap.addEventListener('pointercancel', () => session?.pause?.(false));
}

function setImage(buffer, mime) {
  if (els.img.src) URL.revokeObjectURL(els.img.src);
  const url = URL.createObjectURL(new Blob([buffer], { type: mime || 'image/jpeg' }));
  els.img.src = url;
  return new Promise((resolve) => {
    if (els.img.complete && els.img.naturalWidth) resolve();
    els.img.onload = () => resolve();
    els.img.onerror = () => resolve();
  });
}

function show() {
  init();
  els.root.hidden = false;
  els.img.removeAttribute('src');
  els.loading.hidden = false;
  els.foot.hidden = true;
  els.foot.replaceChildren();
  els.bars.replaceChildren();
  els.ring.toggleAttribute('hidden', true);
  document.body.classList.add('is-viewing');
}

function hide() {
  els.root.hidden = true;
  if (els.img.src) URL.revokeObjectURL(els.img.src);
  els.img.removeAttribute('src');
  document.body.classList.remove('is-viewing');
  session = null;
}

/**
 * Open a snap. The image is fetched (and deleted on the server) right now,
 * shown for `duration` seconds, then gone.
 */
export async function openSnap({ id, duration = 5, user, title, onDone }) {
  show();
  paintAvatar(els.avatar, user);
  els.name.textContent = title;
  els.time.textContent = '';

  let finished = false;
  let timer = null;
  const close = (opened = true) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    hide();
    onDone?.(opened);
  };
  session = { close: () => close(true), next: () => close(true) };

  const res = await ask('open_snap', { id });
  if (finished) return;
  if (!res.ok) {
    close(false);
    toast(errorText(res.error));
    return;
  }
  await setImage(res.image, res.mime);
  if (finished) return;
  els.loading.hidden = true;
  const secs = res.duration || duration;
  els.ring.toggleAttribute('hidden', false);
  els.ring.style.setProperty('--dur', `${secs}s`);
  els.ring.classList.remove('is-running');
  void els.ring.getBoundingClientRect();
  els.ring.classList.add('is-running');
  els.time.textContent = `${secs}s`;
  timer = setTimeout(() => close(true), secs * 1000);
}

/**
 * Play stories. `items` is [{ id, at, user }], started at `index`.
 * `own` shows who viewed each story and a delete button.
 */
export function viewStories(items, { index = 0, own = false, viewers = {}, onDelete, onClose } = {}) {
  if (!items.length) return;
  show();

  let i = index;
  let timer = null;
  let startedAt = 0;
  let remaining = STORY_MS;
  let paused = false;
  let closed = false;
  const cache = new Map();

  const bars = items.map(() => h('span', { class: 'viewer__bar' }, h('i')));
  els.bars.replaceChildren(...bars);

  const load = (n) => {
    if (n < 0 || n >= items.length) return null;
    if (!cache.has(n)) cache.set(n, ask('view_story', { id: items[n].id }));
    return cache.get(n);
  };

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    hide();
    onClose?.();
  };

  const schedule = () => {
    clearTimeout(timer);
    startedAt = performance.now();
    timer = setTimeout(() => go(i + 1), remaining);
  };

  async function go(n) {
    if (n >= items.length) return close();
    if (n < 0) n = 0;
    i = n;
    clearTimeout(timer);
    bars.forEach((bar, k) => {
      bar.classList.toggle('is-done', k < i);
      bar.classList.remove('is-active', 'is-paused');
    });
    const item = items[i];
    paintAvatar(els.avatar, item.user);
    els.name.textContent = own ? 'My story' : item.user.username;
    els.time.textContent = timeAgo(item.at);
    els.loading.hidden = false;
    renderFoot(item);

    const res = await load(i);
    if (closed || i !== n) return;
    if (!res || !res.ok) {
      toast('That story has expired.');
      return go(i + 1);
    }
    await setImage(res.image, res.mime);
    if (closed || i !== n) return;
    els.loading.hidden = true;
    load(i + 1); // preload the next one
    remaining = STORY_MS;
    const bar = bars[i];
    bar.style.setProperty('--dur', `${STORY_MS}ms`);
    void bar.getBoundingClientRect();
    bar.classList.add('is-active');
    schedule();
  }

  function renderFoot(item) {
    if (!own) {
      els.foot.hidden = true;
      return;
    }
    const people = viewers[item.id] || [];
    const del = h('button', { class: 'viewer__delete', type: 'button', text: 'Delete' });
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!window.confirm('Delete this snap from your story?')) return;
      const res = await ask('delete_story', { id: item.id });
      if (!res.ok) return toast(errorText(res.error));
      onDelete?.(item.id);
      items.splice(i, 1);
      bars[i].remove();
      bars.splice(i, 1);
      if (!items.length) return close();
      go(Math.min(i, items.length - 1));
    });
    els.foot.replaceChildren(
      h(
        'p',
        { class: 'viewer__views' },
        h('strong', { text: people.length ? plural(people.length, 'view') : 'No views yet' }),
        people.length ? ` · ${formatList(people.slice(0, 5).map((p) => `@${p.username}`))}${people.length > 5 ? '…' : ''}` : '',
      ),
      del,
    );
    els.foot.hidden = false;
  }

  session = {
    close,
    next: () => go(i + 1),
    prev: () => go(i - 1),
    pause(on) {
      if (closed || on === paused) return;
      paused = on;
      bars[i]?.classList.toggle('is-paused', on);
      if (on) {
        clearTimeout(timer);
        remaining = Math.max(200, remaining - (performance.now() - startedAt));
      } else if (els.loading.hidden) {
        schedule();
      }
    },
  };
  go(i);
}
