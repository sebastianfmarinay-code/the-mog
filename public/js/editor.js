// Snap editor (caption, stickers, drawing, timer) and the "Send to" sheet.

import { ask, config, prefs } from './net.js';
import { $, h, icon, avatar, toast, errorText, bus, formatList } from './ui.js';
import { social } from './social.js';
import { snapIntent, clearSnapIntent, go } from './nav.js';
import { strangerTarget } from './meet.js';

const STICKERS = ['😂', '😍', '🔥', '💀', '😎', '🥹', '👀', '✨', '💯', '🫶', '🎉', '🤡', '😈', '🙈', '👑', '💅', '🍕', '🌈', '⭐', '❤️', '💔', '🤯', '🥶', '🫠'];
const PEN_COLORS = ['#ffffff', '#111111', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2'];
const TIMERS = [1, 3, 5, 10];
const STICKER_SIZES = [0.16, 0.24, 0.34];
const CAPTION_FONT = 0.045; // of image width
const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

const els = {};
const st = {
  photo: null,
  strokes: [],
  current: null,
  drawMode: false,
  penColor: '#ff3b30',
  stickers: [],
  captionOn: false,
  captionY: 0.72,
  timer: 5,
};

// ---------- editor ----------

export function openEditor(photoCanvas) {
  st.photo = photoCanvas;
  st.strokes = [];
  st.stickers = [];
  st.captionOn = false;
  st.captionY = 0.72;
  setDrawMode(false);
  toggleTray(false);

  const { width: w, height: hgt } = photoCanvas;
  els.photo.width = w;
  els.photo.height = hgt;
  els.photo.getContext('2d').drawImage(photoCanvas, 0, 0);
  els.draw.width = w;
  els.draw.height = hgt;
  redrawStrokes();
  els.stickers.replaceChildren();
  els.captionInput.value = '';
  els.caption.hidden = true;
  els.undo.hidden = true;
  renderTimer();

  els.root.hidden = false;
  document.body.classList.add('is-editing');
  layout();
}

function closeEditor() {
  closeSheet();
  els.root.hidden = true;
  document.body.classList.remove('is-editing');
  st.photo = null;
}

function discard() {
  const edited = st.strokes.length || st.stickers.length || els.captionInput.value.trim();
  if (edited && !window.confirm('Discard this snap?')) return;
  closeEditor();
}

/** Fit the photo inside the screen, like object-fit: contain. */
function layout() {
  if (!st.photo) return;
  const box = els.root.getBoundingClientRect();
  const ratio = st.photo.width / st.photo.height;
  let w = box.width;
  let hgt = w / ratio;
  if (hgt > box.height) {
    hgt = box.height;
    w = hgt * ratio;
  }
  els.stage.style.width = `${Math.round(w)}px`;
  els.stage.style.height = `${Math.round(hgt)}px`;
  els.stage.style.setProperty('--u', `${w / 100}px`);
  st.stickers.forEach(placeSticker);
  placeCaption();
}

// ----- drawing -----

function setDrawMode(on) {
  st.drawMode = on;
  els.drawBtn.setAttribute('aria-pressed', String(on));
  els.draw.classList.toggle('is-active', on);
  els.colors.hidden = !on;
  if (on) toggleTray(false);
}

function toImage(e) {
  const rect = els.draw.getBoundingClientRect();
  return [((e.clientX - rect.left) / rect.width) * els.draw.width, ((e.clientY - rect.top) / rect.height) * els.draw.height];
}

function strokePath(ctx, stroke) {
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const [first, ...rest] = stroke.points;
  if (!rest.length) {
    ctx.beginPath();
    ctx.arc(first[0], first[1], stroke.width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(first[0], first[1]);
  for (const [x, y] of rest) ctx.lineTo(x, y);
  ctx.stroke();
}

function redrawStrokes() {
  const ctx = els.draw.getContext('2d');
  ctx.clearRect(0, 0, els.draw.width, els.draw.height);
  st.strokes.forEach((s) => strokePath(ctx, s));
}

function bindDrawing() {
  els.draw.addEventListener('pointerdown', (e) => {
    if (!st.drawMode) return;
    e.preventDefault();
    els.draw.setPointerCapture(e.pointerId);
    st.current = { color: st.penColor, width: Math.max(4, els.draw.width * 0.012), points: [toImage(e)] };
    st.strokes.push(st.current);
    redrawStrokes();
  });
  els.draw.addEventListener('pointermove', (e) => {
    if (!st.current) return;
    st.current.points.push(toImage(e));
    redrawStrokes();
  });
  const end = () => {
    if (!st.current) return;
    st.current = null;
    els.undo.hidden = !st.strokes.length;
  };
  els.draw.addEventListener('pointerup', end);
  els.draw.addEventListener('pointercancel', end);
  els.undo.addEventListener('click', () => {
    st.strokes.pop();
    redrawStrokes();
    els.undo.hidden = !st.strokes.length;
  });

  els.colors.replaceChildren(
    ...PEN_COLORS.map((color) => {
      const btn = h('button', { class: 'pen-color', type: 'button', 'aria-label': `Pen colour ${color}`, 'aria-pressed': String(color === st.penColor) });
      btn.style.setProperty('--c', color);
      btn.addEventListener('click', () => {
        st.penColor = color;
        els.colors.querySelectorAll('.pen-color').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      });
      return btn;
    }),
  );
}

// ----- stickers -----

function toggleTray(force) {
  const open = force ?? els.tray.hidden;
  els.tray.hidden = !open;
  els.stickerBtn.setAttribute('aria-pressed', String(open));
  if (open) setDrawMode(false);
}

function placeSticker(s) {
  const width = els.stage.getBoundingClientRect().width;
  s.el.style.left = `${s.x * 100}%`;
  s.el.style.top = `${s.y * 100}%`;
  s.el.style.fontSize = `${s.size * width}px`;
}

function addSticker(emoji) {
  const s = { emoji, x: 0.5, y: 0.42, size: STICKER_SIZES[1], el: h('div', { class: 'sticker', role: 'img', 'aria-label': emoji, text: emoji }) };
  st.stickers.push(s);
  els.stickers.append(s.el);
  placeSticker(s);
  bindSticker(s);
  toggleTray(false);
}

function bindSticker(s) {
  let start = null;
  const overTrash = (e) => {
    const r = els.trash.getBoundingClientRect();
    return e.clientX >= r.left - 12 && e.clientX <= r.right + 12 && e.clientY >= r.top - 12 && e.clientY <= r.bottom + 12;
  };
  s.el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    s.el.setPointerCapture(e.pointerId);
    start = { x: e.clientX, y: e.clientY, sx: s.x, sy: s.y, moved: false };
  });
  s.el.addEventListener('pointermove', (e) => {
    if (!start) return;
    const rect = els.stage.getBoundingClientRect();
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 6) return;
    start.moved = true;
    els.trash.hidden = false;
    els.trash.classList.toggle('is-hot', overTrash(e));
    s.x = Math.min(1, Math.max(0, start.sx + dx / rect.width));
    s.y = Math.min(1, Math.max(0, start.sy + dy / rect.height));
    placeSticker(s);
  });
  s.el.addEventListener('pointerup', (e) => {
    if (!start) return;
    const { moved } = start;
    start = null;
    els.trash.hidden = true;
    els.trash.classList.remove('is-hot');
    if (moved && overTrash(e)) {
      s.el.remove();
      st.stickers = st.stickers.filter((x) => x !== s);
    } else if (!moved) {
      // Tap cycles through sizes.
      const i = STICKER_SIZES.indexOf(s.size);
      s.size = STICKER_SIZES[(i + 1) % STICKER_SIZES.length];
      placeSticker(s);
    }
  });
  s.el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      s.size = Math.min(0.5, Math.max(0.08, s.size * (e.deltaY < 0 ? 1.1 : 0.9)));
      placeSticker(s);
    },
    { passive: false },
  );
}

// ----- caption -----

function placeCaption() {
  els.caption.style.top = `${st.captionY * 100}%`;
}

function showCaption() {
  st.captionOn = true;
  els.caption.hidden = false;
  placeCaption();
  editCaption();
}

function editCaption() {
  els.caption.classList.add('is-editing');
  els.captionInput.focus();
}

function bindCaption() {
  els.captionInput.addEventListener('blur', () => {
    els.caption.classList.remove('is-editing');
    if (!els.captionInput.value.trim()) {
      st.captionOn = false;
      els.caption.hidden = true;
    }
  });
  els.captionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      els.captionInput.blur();
    }
  });
  let start = null;
  els.captionGrip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    els.captionGrip.setPointerCapture(e.pointerId);
    start = { y: e.clientY, cy: st.captionY, moved: false };
  });
  els.captionGrip.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dy = e.clientY - start.y;
    if (!start.moved && Math.abs(dy) < 6) return;
    start.moved = true;
    const rect = els.stage.getBoundingClientRect();
    st.captionY = Math.min(0.94, Math.max(0.06, start.cy + dy / rect.height));
    placeCaption();
  });
  els.captionGrip.addEventListener('pointerup', () => {
    if (start && !start.moved) editCaption();
    start = null;
  });
}

// ----- timer -----

function renderTimer() {
  els.timerLabel.textContent = `${st.timer}s`;
  els.timerBtn.setAttribute('aria-label', `Snap timer: ${st.timer} seconds`);
}

// ----- export -----

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

function toBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/** Flatten photo + drawing + stickers + caption into a JPEG. */
async function compose() {
  const W = st.photo.width;
  const H = st.photo.height;
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d');
  ctx.drawImage(els.photo, 0, 0);
  ctx.drawImage(els.draw, 0, 0);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const s of st.stickers) {
    ctx.font = `${Math.round(s.size * W)}px ${EMOJI_FONT}`;
    ctx.fillText(s.emoji, s.x * W, s.y * H);
  }

  const text = els.captionInput.value.trim();
  if (st.captionOn && text) {
    const fs = Math.round(W * CAPTION_FONT);
    const bar = Math.round(fs * 2.1);
    const y = st.captionY * H;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, Math.round(y - bar / 2), W, bar);
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${fs}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.fillText(fitText(ctx, text, W - fs * 2), W / 2, y);
  }

  let blob = await toBlob(out, 0.85);
  let canvas = out;
  // Shrink until it fits the server's limit.
  while (blob && blob.size > config.maxImageBytes * 0.95 && canvas.width > 320) {
    const smaller = document.createElement('canvas');
    smaller.width = Math.round(canvas.width * 0.8);
    smaller.height = Math.round(canvas.height * 0.8);
    smaller.getContext('2d').drawImage(canvas, 0, 0, smaller.width, smaller.height);
    canvas = smaller;
    blob = await toBlob(canvas, 0.8);
  }
  return blob;
}

async function save() {
  const blob = await compose();
  if (!blob) return toast("Couldn't save that snap.");
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `snap-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Saved to your device');
}

// ---------- send sheet ----------

function intendedFriendId() {
  const t = snapIntent.target;
  if (t?.type === 'friend') return t.id;
  if (t?.type === 'stranger') return strangerTarget()?.friendId || null;
  return null;
}

const sheet = { blob: null, selected: new Set(), rows: [] };

function sendTargets() {
  const rows = [];
  rows.push({ key: 'story', label: 'My story', sub: 'All your friends · 24 hours', kind: 'story' });
  // A stranger you've friended is listed as a friend instead (so the snap
  // counts toward your streak); it still shows up in the live chat.
  const stranger = strangerTarget();
  if (stranger && !stranger.friendId) rows.push({ key: 'stranger', label: stranger.label, sub: stranger.sub, kind: 'stranger' });
  const intentId = intendedFriendId();
  const friends = [...social.friends].sort((a, b) => {
    if (a.id === intentId) return -1;
    if (b.id === intentId) return 1;
    return (b.streak || 0) - (a.streak || 0) || a.username.localeCompare(b.username);
  });
  for (const f of friends) {
    rows.push({
      key: `f:${f.id}`,
      label: f.username,
      sub: f.streak ? `🔥 ${f.streak}${f.atRisk ? ' · snap today to keep it' : ''}` : f.online ? 'Online' : '',
      kind: 'friend',
      user: f,
    });
  }
  return rows;
}

function renderSheet() {
  els.sendList.replaceChildren(
    ...sheet.rows.map((row) => {
      const checked = sheet.selected.has(row.key);
      let lead;
      if (row.kind === 'story') lead = h('span', { class: 'send-row__icon send-row__icon--story' }, icon('stories'));
      else if (row.kind === 'stranger') lead = h('span', { class: 'send-row__icon send-row__icon--stranger' }, icon('meet'));
      else lead = avatar(row.user, 'md', { online: row.user.online });
      const btn = h(
        'button',
        { class: 'send-row', type: 'button', role: 'checkbox', 'aria-checked': String(checked) },
        lead,
        h('span', { class: 'send-row__text' }, h('strong', { text: row.kind === 'friend' ? `@${row.label}` : row.label }), row.sub ? h('span', { text: row.sub }) : null),
        h('span', { class: 'send-row__check' }, icon('check')),
      );
      btn.addEventListener('click', () => {
        if (sheet.selected.has(row.key)) sheet.selected.delete(row.key);
        else sheet.selected.add(row.key);
        renderSheet();
      });
      return h('li', {}, btn);
    }),
  );
  if (!social.friends.length) {
    els.sendList.append(h('li', { class: 'send-list__hint', text: 'Add friends to send them snaps — tap Add friend when you meet someone you like.' }));
  }
  const names = sheet.rows
    .filter((r) => sheet.selected.has(r.key))
    .map((r) => (r.kind === 'friend' ? `@${r.label}` : r.label));
  els.sendSummary.textContent = names.length ? formatList(names) : 'Pick who gets it';
  els.sendGo.disabled = !names.length;
}

async function openSheet() {
  els.send.disabled = true;
  const blob = await compose();
  els.send.disabled = false;
  if (!blob) return toast("Couldn't prepare that snap. Try again.");
  sheet.blob = blob;
  sheet.rows = sendTargets();
  sheet.selected = new Set();
  const t = snapIntent.target;
  const friendId = intendedFriendId();
  if (friendId && social.friend(friendId)) sheet.selected.add(`f:${friendId}`);
  else if (t?.type === 'stranger' && strangerTarget()) sheet.selected.add('stranger');
  if (t?.type === 'story') sheet.selected.add('story');
  renderSheet();
  els.sheet.hidden = false;
  els.sendGo.focus();
}

function closeSheet() {
  els.sheet.hidden = true;
  sheet.blob = null;
}

async function send() {
  if (!sheet.blob || !sheet.selected.size) return;
  els.sendGo.disabled = true;
  const to = [...sheet.selected].filter((k) => k.startsWith('f:')).map((k) => k.slice(2));
  const payload = {
    image: await sheet.blob.arrayBuffer(),
    duration: st.timer,
    to,
    stranger: sheet.selected.has('stranger'),
    story: sheet.selected.has('story'),
  };
  const names = els.sendSummary.textContent;
  const res = await ask('snap', payload, 30000);
  els.sendGo.disabled = false;
  if (!res.ok) return toast(errorText(res.error));
  if (payload.stranger && !res.stranger) toast('The stranger left before your snap was sent.');
  bus.emit('snap_sent', res);
  toast(`Sent to ${names}`);
  closeEditor();
  const back = snapIntent.returnTo;
  clearSnapIntent();
  if (back) go(back);
}

// ---------- init ----------

export function initEditor() {
  Object.assign(els, {
    root: $('#editor'),
    stage: $('#editor-stage'),
    photo: $('#editor-photo'),
    draw: $('#editor-draw'),
    stickers: $('#editor-stickers'),
    caption: $('#editor-caption'),
    captionInput: $('#editor-caption-input'),
    captionGrip: $('#editor-caption-grip'),
    close: $('#editor-close'),
    textBtn: $('#tool-text'),
    stickerBtn: $('#tool-sticker'),
    drawBtn: $('#tool-draw'),
    undo: $('#tool-undo'),
    timerBtn: $('#tool-timer'),
    timerLabel: $('#timer-label'),
    saveBtn: $('#tool-save'),
    colors: $('#draw-colors'),
    tray: $('#sticker-tray'),
    trash: $('#editor-trash'),
    send: $('#editor-send'),
    sheet: $('#send-sheet'),
    sendList: $('#send-list'),
    sendSummary: $('#send-summary'),
    sendGo: $('#send-go'),
  });

  st.timer = TIMERS.includes(prefs.get('snapTimer', 5)) ? prefs.get('snapTimer', 5) : 5;
  bindDrawing();
  bindCaption();

  els.tray.replaceChildren(
    ...STICKERS.map((emoji) => h('button', { class: 'sticker-tray__item', type: 'button', 'aria-label': `Sticker ${emoji}`, text: emoji, onclick: () => addSticker(emoji) })),
  );

  els.close.addEventListener('click', discard);
  els.textBtn.addEventListener('click', () => (st.captionOn ? editCaption() : showCaption()));
  els.stickerBtn.addEventListener('click', () => toggleTray());
  els.drawBtn.addEventListener('click', () => setDrawMode(!st.drawMode));
  els.timerBtn.addEventListener('click', () => {
    st.timer = TIMERS[(TIMERS.indexOf(st.timer) + 1) % TIMERS.length];
    prefs.set('snapTimer', st.timer);
    renderTimer();
  });
  els.saveBtn.addEventListener('click', save);
  els.send.addEventListener('click', openSheet);
  els.sendGo.addEventListener('click', send);
  els.sheet.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeSheet));

  window.addEventListener('resize', layout);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || els.root.hidden) return;
    if (document.activeElement === els.captionInput) return;
    e.preventDefault();
    if (!els.sheet.hidden) closeSheet();
    else discard();
  });
}
