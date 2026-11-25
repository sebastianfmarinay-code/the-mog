// Chats: friend list with streaks, friend requests, and conversations where
// messages disappear once they've been seen and you leave the chat.

import { socket, ask } from './net.js';
import { $, h, icon, avatar, paintAvatar, bus, toast, errorText, timeAgo, autosize, isTouch, showError } from './ui.js';
import { social } from './social.js';
import { snapTo, currentTab, go } from './nav.js';
import { openSnap } from './viewer.js';
import { meetPartnerFriendId } from './meet.js';

const els = {};
const convos = new Map(); // friendId -> entries shown in the open chat
const lastSent = new Map(); // friendId -> { kind, status, at } for the list's status line
const sentSnapOwner = new Map(); // snap id -> friendId
const sentMessages = new Map(); // message id -> entry
let openId = null;
let typingTimer = null;
let typingSentAt = 0;
let theirTypingTimer = null;

const convoFor = (id) => convos.get(id) || convos.set(id, []).get(id);

// ---------- friend list ----------

function statusLine(friend) {
  const unread = social.unread(friend.id);
  if (unread.snaps) {
    return h('span', { class: 'fl-status is-new' }, h('i', { class: 'mark mark--snap' }), `New snap${unread.snaps > 1 ? 's' : ''}`, h('em', { text: ` · ${timeAgo(unread.latest)}` }));
  }
  if (unread.messages) {
    return h('span', { class: 'fl-status is-new' }, h('i', { class: 'mark mark--chat' }), 'New chat', h('em', { text: ` · ${timeAgo(unread.latest)}` }));
  }
  const sent = lastSent.get(friend.id);
  if (sent) {
    const kind = sent.kind === 'snap' ? 'snap' : 'chat';
    return h('span', { class: 'fl-status' }, h('i', { class: `mark mark--${kind} mark--outline` }), sent.status, h('em', { text: ` · ${timeAgo(sent.at)}` }));
  }
  return h('span', { class: 'fl-status' }, friend.online ? 'Online now' : 'Tap to chat');
}

function sortedFriends() {
  return [...social.friends].sort((a, b) => {
    const ua = social.unread(a.id).latest;
    const ub = social.unread(b.id).latest;
    if (ua !== ub) return ub - ua;
    const sa = lastSent.get(a.id)?.at || 0;
    const sb = lastSent.get(b.id)?.at || 0;
    if (sa !== sb) return sb - sa;
    return (b.streak || 0) - (a.streak || 0) || a.username.localeCompare(b.username);
  });
}

function renderRequests() {
  const { incoming, outgoing } = social.requests;
  els.requests.hidden = !incoming.length && !outgoing.length;
  const rows = [];
  for (const user of incoming) {
    rows.push(
      h(
        'div',
        { class: 'request' },
        avatar(user, 'md'),
        h('span', { class: 'request__text' }, h('strong', { text: `@${user.username}` }), h('span', { text: 'wants to be friends' })),
        h('button', { class: 'btn btn--accent btn--sm', type: 'button', text: 'Accept', onclick: () => respond(user, true) }),
        h('button', { class: 'round-btn', type: 'button', 'aria-label': `Decline @${user.username}`, onclick: () => respond(user, false) }, icon('x')),
      ),
    );
  }
  for (const user of outgoing) {
    rows.push(
      h(
        'div',
        { class: 'request request--out' },
        avatar(user, 'md'),
        h('span', { class: 'request__text' }, h('strong', { text: `@${user.username}` }), h('span', { text: 'Request sent' })),
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Cancel', onclick: () => cancelRequest(user) }),
      ),
    );
  }
  els.requests.replaceChildren(h('h3', { class: 'section-label', text: 'Requests' }), ...rows);
}

async function respond(user, accept) {
  const res = await ask('respond_request', { from: user.id, accept });
  if (!res.ok) return toast(errorText(res.error));
  if (accept) toast(`You and @${user.username} are now friends`);
  social.sync();
}

async function cancelRequest(user) {
  await ask('cancel_request', { to: user.id });
  social.sync();
}

function renderList() {
  renderRequests();
  const friends = sortedFriends();
  els.empty.hidden = friends.length > 0;
  els.list.replaceChildren(
    ...friends.map((f) => {
      const streak = f.streak
        ? h('span', { class: `streak${f.atRisk ? ' is-at-risk' : ''}`, title: f.atRisk ? 'Snap each other today to keep your streak' : `${f.streak}-day streak` }, `🔥 ${f.streak}`, f.atRisk ? ' ⏳' : '')
        : null;
      const btn = h(
        'button',
        { class: `friend${openId === f.id ? ' is-open' : ''}`, type: 'button' },
        avatar(f, 'md', { online: f.online }),
        h('span', { class: 'friend__body' }, h('strong', { class: 'friend__name', text: f.username }), statusLine(f)),
        streak,
      );
      btn.addEventListener('click', () => openConvo(f.id));
      return h('li', {}, btn);
    }),
  );
  updateBadge();
}

function updateBadge() {
  const count = social.friends.filter((f) => {
    const u = social.unread(f.id);
    return u.snaps || u.messages;
  }).length + social.requests.incoming.length;
  bus.emit('badge', { tab: 'chats', count });
}

// ---------- conversation ----------

function openConvo(id) {
  const friend = social.friend(id);
  if (!friend) return;
  if (openId && openId !== id) closeConvo();
  openId = id;
  els.root.classList.add('is-open');
  els.convo.hidden = false;
  els.placeholder.hidden = true;
  renderHeader();
  markRead();
  renderConvo();
  renderList();
  if (!isTouch()) els.input.focus();
}

/** Leaving a chat clears what was seen — chats disappear after viewing. */
function closeConvo() {
  if (!openId) return;
  stopTyping();
  const kept = convoFor(openId).filter((e) => e.mine && e.kind === 'text' && e.status !== 'Seen' && e.status !== 'Failed');
  if (kept.length) convos.set(openId, kept);
  else convos.delete(openId);
  openId = null;
  els.root.classList.remove('is-open');
  els.convo.hidden = true;
  els.placeholder.hidden = false;
  els.typing.hidden = true;
  renderList();
}

function renderHeader() {
  const friend = social.friend(openId);
  if (!friend) return;
  paintAvatar(els.avatar, friend);
  els.name.textContent = `@${friend.username}`;
  const bits = [];
  if (friend.streak) bits.push(`🔥 ${friend.streak}-day streak${friend.atRisk ? ' · snap today!' : ''}`);
  bits.push(friend.online ? 'Online' : 'Offline');
  els.sub.textContent = bits.join(' · ');
}

function markRead() {
  if (!openId) return;
  const msgs = social.messagesFrom(openId);
  if (!msgs.length) return;
  const list = convoFor(openId);
  for (const m of msgs) list.push({ id: m.id, mine: false, kind: 'text', text: m.text, at: m.at });
  list.sort((a, b) => a.at - b.at);
  social.removeInbox(msgs.map((m) => m.id));
  ask('read_messages', { from: openId });
}

function snapBubble(item, friend) {
  const btn = h(
    'button',
    { class: 'bubble-snap bubble-snap--new', type: 'button' },
    h('i', { class: 'mark mark--snap' }),
    h('span', {}, h('strong', { text: 'New snap' }), h('span', { text: 'Tap to view' })),
  );
  btn.addEventListener('click', () =>
    openSnap({
      id: item.id,
      duration: item.duration,
      user: friend,
      title: `@${friend.username}`,
      onDone: (ok) => {
        social.removeInbox([item.id]);
        if (ok) convoFor(friend.id).push({ id: item.id, mine: false, kind: 'snap', at: item.at, status: 'Opened' });
        renderConvo();
        renderList();
      },
    }),
  );
  return btn;
}

function renderConvo() {
  if (!openId) return;
  const friend = social.friend(openId);
  if (!friend) return;
  const stick = isNearBottom();
  const nodes = [h('p', { class: 'convo__hint', text: "Chats disappear once they've been seen and you leave the chat." })];

  const entries = convoFor(openId);
  const lastMineText = entries.filter((e) => e.mine && e.kind === 'text').pop();
  for (const entry of entries) {
    if (entry.kind === 'snap') {
      nodes.push(
        h(
          'div',
          { class: `bubble-snap ${entry.mine ? 'is-mine' : ''} ${entry.status === 'Opened' ? 'is-opened' : ''}` },
          h('i', { class: 'mark mark--snap mark--outline' }),
          h('span', {}, h('strong', { text: entry.mine ? 'You sent a snap' : 'Snap' }), h('span', { text: entry.status })),
        ),
      );
      continue;
    }
    const bubble = h('div', { class: `bubble ${entry.mine ? 'is-mine' : ''} ${entry.status === 'Failed' ? 'is-failed' : ''}` }, h('span', { class: 'bubble__text', text: entry.text }));
    nodes.push(bubble);
    // Delivery state under the last message I sent.
    if (entry === lastMineText) nodes.push(h('p', { class: 'convo__receipt', text: entry.status }));
  }

  for (const snap of social.snapsFrom(openId)) nodes.push(snapBubble(snap, friend));

  els.log.replaceChildren(...nodes);
  if (stick) els.log.scrollTop = els.log.scrollHeight;
}

function isNearBottom() {
  const { scrollTop, scrollHeight, clientHeight } = els.log;
  return scrollHeight - scrollTop - clientHeight < 120;
}

async function sendDm() {
  const text = els.input.value.trim();
  if (!text || !openId) return;
  const to = openId;
  const entry = { id: null, mine: true, kind: 'text', text, at: Date.now(), status: 'Sending…' };
  convoFor(to).push(entry);
  els.input.value = '';
  autosize(els.input);
  els.send.disabled = true;
  stopTyping();
  renderConvo();
  els.log.scrollTop = els.log.scrollHeight;

  const res = await ask('dm', { to, text });
  if (res.ok) {
    entry.id = res.id;
    entry.status = 'Delivered';
    sentMessages.set(res.id, entry);
    lastSent.set(to, { kind: 'chat', status: 'Delivered', at: Date.now() });
  } else {
    entry.status = 'Failed';
    toast(errorText(res.error));
  }
  if (openId === to) renderConvo();
  renderList();
}

function stopTyping() {
  clearTimeout(typingTimer);
  if (typingSentAt && openId) socket.emit('dm_typing', { to: openId, typing: false });
  typingSentAt = 0;
}

function onInput() {
  autosize(els.input);
  const hasText = Boolean(els.input.value.trim());
  els.send.disabled = !hasText;
  if (!openId) return;
  if (!hasText) return stopTyping();
  if (Date.now() - typingSentAt > 2500) {
    typingSentAt = Date.now();
    socket.emit('dm_typing', { to: openId, typing: true });
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, 3000);
}

async function removeFriend() {
  const friend = social.friend(openId);
  if (!friend || !window.confirm(`Remove @${friend.username} from your friends? Your streak will be lost.`)) return;
  const res = await ask('remove_friend', { id: friend.id });
  if (!res.ok) return toast(errorText(res.error));
  closeConvo();
  toast(`Removed @${friend.username}`);
  social.sync();
}

// ---------- add by username ----------

function openAddDialog() {
  els.addInput.value = '';
  showError(els.addError, '');
  els.addDialog.showModal();
  els.addInput.focus();
}

async function submitAdd(e) {
  e.preventDefault();
  if (e.submitter && e.submitter.value === 'cancel') {
    els.addDialog.close();
    return;
  }
  const username = els.addInput.value.trim().replace(/^@/, '');
  if (!username) return showError(els.addError, 'Type a username.');
  els.addSubmit.disabled = true;
  const res = await ask('friend_request', { username });
  els.addSubmit.disabled = false;
  if (!res.ok) return showError(els.addError, errorText(res.error));
  els.addDialog.close();
  toast(res.status === 'friends' ? `You and @${res.user.username} are now friends` : `Friend request sent to @${res.user.username}`);
  social.sync();
}

// ---------- live events ----------

function bindEvents() {
  bus.on('social', () => {
    if (openId && !social.friend(openId)) {
      closeConvo();
      toast("You're no longer friends with that person.");
    }
    if (openId && currentTab() === 'chats' && document.visibilityState === 'visible') {
      markRead();
      renderHeader();
      renderConvo();
    }
    renderList();
  });

  bus.on('inbox_item', (item) => {
    const friend = social.friend(item.from);
    const viewing = openId === item.from && currentTab() === 'chats' && document.visibilityState === 'visible';
    if (viewing) return; // the 'social' handler shows it and marks it read
    if (!friend) return;
    // Snaps from the person you're live-chatting with show up in that chat instead.
    if (item.type === 'snap' && meetPartnerFriendId() === item.from && currentTab() === 'meet') return;
    const what = item.type === 'snap' ? `📸 New snap from @${friend.username}` : `💬 @${friend.username}: ${item.text.slice(0, 60)}`;
    toast(what, {
      key: `friend:${friend.id}`,
      action: 'View',
      onAction: () => {
        go('chats');
        openConvo(friend.id);
      },
    });
  });

  bus.on('snap_sent', ({ sent }) => {
    for (const { to, id } of sent || []) {
      sentSnapOwner.set(id, to);
      convoFor(to).push({ id, mine: true, kind: 'snap', at: Date.now(), status: 'Delivered' });
      lastSent.set(to, { kind: 'snap', status: 'Delivered', at: Date.now() });
    }
    renderConvo();
    renderList();
  });

  bus.on('snap_opened', ({ id, by }) => {
    if (!by) return;
    const entry = (convos.get(by) || []).find((e) => e.id === id);
    if (entry) entry.status = 'Opened';
    const last = lastSent.get(by);
    if (last && last.kind === 'snap') last.status = 'Opened';
    renderConvo();
    renderList();
  });

  bus.on('messages_seen', ({ by, ids }) => {
    for (const id of ids) {
      const entry = sentMessages.get(id);
      if (entry) entry.status = 'Seen';
      sentMessages.delete(id);
    }
    const last = lastSent.get(by);
    if (last && last.kind === 'chat') last.status = 'Seen';
    if (openId === by) renderConvo();
    renderList();
  });

  bus.on('dm_typing', ({ from, typing }) => {
    if (from !== openId) return;
    els.typing.hidden = !typing;
    els.typingWho.textContent = `@${social.friend(from)?.username || ''}`;
    clearTimeout(theirTypingTimer);
    if (typing) theirTypingTimer = setTimeout(() => (els.typing.hidden = true), 6000);
  });

  bus.on('friend_request', (from) => {
    toast(`@${from.username} wants to be friends`, { action: 'View', onAction: () => go('chats') });
  });
  bus.on('friend_accepted', (by) => toast(`@${by.username} is now your friend`));
}

// ---------- tab hooks & init ----------

export function showChats() {
  if (openId) {
    markRead();
    renderConvo();
  }
  renderList();
}

export function initChats() {
  Object.assign(els, {
    root: $('.chats'),
    requests: $('#requests'),
    list: $('#friend-list'),
    empty: $('#friends-empty'),
    convo: $('#convo'),
    placeholder: $('#convo-placeholder'),
    back: $('#convo-back'),
    avatar: $('#convo-avatar'),
    name: $('#convo-name'),
    sub: $('#convo-sub'),
    remove: $('#convo-remove'),
    log: $('#convo-log'),
    typing: $('#convo-typing'),
    typingWho: $('#convo-typing-who'),
    form: $('#convo-form'),
    input: $('#convo-input'),
    send: $('#convo-send'),
    camera: $('#convo-camera'),
    addBtn: $('#add-friend-btn'),
    addDialog: $('#add-dialog'),
    addForm: $('#add-form'),
    addInput: $('#add-username'),
    addError: $('#add-error'),
    addSubmit: $('#add-submit'),
  });

  bindEvents();
  els.back.addEventListener('click', closeConvo);
  els.remove.addEventListener('click', removeFriend);
  els.camera.addEventListener('click', () => openId && snapTo({ type: 'friend', id: openId }, 'chats'));
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendDm();
  });
  els.input.addEventListener('input', onInput);
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendDm();
    }
  });
  els.addBtn.addEventListener('click', openAddDialog);
  els.addForm.addEventListener('submit', submitAdd);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openId && currentTab() === 'chats' && !document.querySelector('dialog[open], #viewer:not([hidden])')) {
      closeConvo();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentTab() === 'chats') showChats();
  });
  setInterval(() => currentTab() === 'chats' && renderList(), 60_000);
}
