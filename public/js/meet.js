// Meet: random text/video chat with strangers (the matchmaking side).

import { socket, ask, config, prefs } from './net.js';
import { $, h, bus, autosize, formatList, isTouch, toast, errorText, icon } from './ui.js';
import { camera, bindPreview, filterStrip, cameraErrorMessage } from './camera.js';
import { currentTab, snapTo, overlayOpen } from './nav.js';
import { openSnap } from './viewer.js';
import { social } from './social.js';

const SKIP_CONFIRM_MS = 3000;
const AUTO_NEXT_DELAY_MS = 1500;
const TYPING_IDLE_MS = 3000;

const els = {};
const state = {
  live: false,
  mode: 'text',
  interests: [],
  status: 'idle', // idle | searching | chatting | ended
  confirmSkip: false,
  confirmTimer: null,
  autoTimer: null,
  typingTimer: null,
  sentTyping: false,
  unread: 0,
  pc: null,
  videoSender: null,
  pendingCandidates: [],
  signalQueue: Promise.resolve(),
  seq: 0,
  partnerName: null,
  partnerFriendId: null, // set once you and the stranger add each other
  addState: 'idle', // idle | waiting | incoming | friends
  sentSnaps: new Map(), // stranger snap id -> status element
};

/**
 * Info about the stranger you're talking to, for the snap send sheet.
 * Once you've friended them, `friendId` is set and snaps go to them as a
 * friend (so they count toward your streak) but still show up in this chat.
 */
export function strangerTarget() {
  if (state.status !== 'chatting') return null;
  return { label: state.partnerName || 'Stranger', sub: "The person you're chatting with", friendId: state.partnerFriendId };
}

/** Friend id of the person in the current random chat, if you've friended them. */
export function meetPartnerFriendId() {
  return state.status === 'chatting' ? state.partnerFriendId : null;
}

export function isLive() {
  return state.live;
}

// ---------- socket events ----------

function bindSocket() {
  socket.on('searching', ({ interests, seq }) => {
    if (seq !== state.seq || state.status !== 'searching') return;
    clearLog();
    const row = addSystem(
      interests && interests.length
        ? `Looking for someone into ${formatList(interests, 'or')}`
        : 'Looking for someone you can chat with',
    );
    row.classList.add('sys--searching');
  });

  socket.on('matched', ({ mode, common, initiator, seq }) => {
    if (seq !== state.seq || state.status !== 'searching') return;
    clearLog();
    state.partnerName = null;
    state.partnerFriendId = null;
    state.addState = 'idle';
    state.sentSnaps.clear();
    setStatus('chatting');

    const hello = addSystem("You're now chatting with a random stranger. Say hi!", 'hello');
    if (common && common.length) {
      hello.append(
        h('div', { class: 'sys__label', text: 'You both like:' }),
        h('div', { class: 'sys__tags' }, common.map((t) => h('span', { class: 'tag' }, h('span', { class: 'tag__text', text: t })))),
      );
    } else if (state.interests.length) {
      addSystem("Nobody shared your interests right now, so here's a random stranger.");
    }

    if (mode === 'video' && camera.active) startPeer(initiator);
    if (!isTouch() && currentTab() === 'meet' && !overlayOpen()) els.input.focus();
    notify('Connected to a stranger');
  });

  socket.on('message', ({ text }) => {
    if (state.status !== 'chatting') return;
    showTyping(false);
    addMessage('stranger', text);
    notify('New message');
  });

  socket.on('typing', (on) => showTyping(Boolean(on) && state.status === 'chatting'));

  socket.on('partner_left', () => {
    if (state.status !== 'chatting') return;
    const name = state.partnerName || 'Stranger';
    closePeer();
    setStatus('ended');
    addSystem(`${name} has disconnected.`, 'strong');
    notify('Stranger disconnected');
    scheduleAutoNext();
  });

  socket.on('signal', (data) => {
    const pc = state.pc;
    if (!pc) return;
    state.signalQueue = state.signalQueue.then(() => handleSignal(pc, data)).catch(() => {});
  });

  socket.on('banned', ({ remainingMs }) => {
    const mins = Math.max(1, Math.ceil((remainingMs || 0) / 60000));
    leave({ silent: true });
    showAlert(`You've been temporarily blocked after several reports. Try again in about ${mins} minute${mins === 1 ? '' : 's'}.`);
  });

  socket.on('disconnect', () => {
    if (state.status === 'searching' || state.status === 'chatting') {
      closePeer();
      setStatus('ended');
      addSystem('Lost connection to the server. Reconnecting…', 'strong');
    }
  });

  socket.on('snap_received', ({ id, duration }) => showIncomingSnap(id, duration));

  // A friended stranger's snaps arrive in your inbox; show them here too.
  bus.on('inbox_item', (item) => {
    if (item.type === 'snap' && state.partnerFriendId && item.from === state.partnerFriendId) {
      showIncomingSnap(item.id, item.duration, () => social.removeInbox([item.id]));
    }
  });

  function showIncomingSnap(id, duration, afterOpen) {
    if (state.status !== 'chatting') return;
    const status = h('span', { class: 'snap-row__status', text: 'Tap to view' });
    const row = h(
      'button',
      { class: 'snap-row snap-row--new', type: 'button' },
      h('span', { class: 'snap-row__icon', 'aria-hidden': 'true' }),
      h('span', { class: 'snap-row__text' }, h('strong', { text: `${state.partnerName || 'Stranger'} sent a snap` }), status),
    );
    row.addEventListener('click', () => {
      if (row.disabled) return;
      openSnap({
        id,
        duration,
        user: { username: state.partnerName ? state.partnerName.slice(1) : null },
        title: state.partnerName || 'Stranger',
        onDone: (ok) => {
          row.disabled = true;
          row.classList.replace('snap-row--new', 'snap-row--opened');
          status.textContent = ok ? 'Opened' : 'Expired';
          afterOpen?.();
        },
      });
    });
    appendRow(row);
    notify('New snap');
  }

  socket.on('stranger_wants_add', () => {
    if (state.status !== 'chatting' || state.addState === 'friends') return;
    state.addState = 'incoming';
    renderAddButton();
    const row = addSystem('Stranger wants to add you as a friend.', 'strong');
    row.append(
      h('button', { class: 'inline-btn', type: 'button', onclick: addFriend, text: 'Add back' }),
    );
  });

  socket.on('stranger_friended', ({ friend }) => {
    state.addState = 'friends';
    state.partnerName = `@${friend.username}`;
    state.partnerFriendId = friend.id;
    renderAddButton();
    els.remoteTag.textContent = state.partnerName;
    els.typingWho.textContent = state.partnerName;
    const row = addSystem(`🎉 You're now friends with ${state.partnerName}! They'll stay in your Chats.`, 'hello');
    row.classList.add('sys--friends');
    toast(`You and ${state.partnerName} are now friends`);
  });

  bus.on('snap_opened', ({ id }) => {
    const statusEl = state.sentSnaps.get(id);
    if (statusEl) {
      statusEl.textContent = 'Opened';
      statusEl.closest('.snap-row')?.classList.replace('snap-row--sent', 'snap-row--opened');
    }
  });

  bus.on('snap_sent', ({ stranger, sent }) => {
    if (state.status !== 'chatting') return;
    const toFriend = state.partnerFriendId && (sent || []).find((s) => s.to === state.partnerFriendId);
    const id = stranger || (toFriend && toFriend.id);
    if (!id) return;
    const status = h('span', { class: 'snap-row__status', text: 'Delivered' });
    appendRow(
      h(
        'div',
        { class: 'snap-row snap-row--sent' },
        h('span', { class: 'snap-row__icon', 'aria-hidden': 'true' }),
        h('span', { class: 'snap-row__text' }, h('strong', { text: 'You sent a snap' }), status),
      ),
    );
    state.sentSnaps.set(id, status);
  });
}

// ---------- lobby / live ----------

function showAlert(message) {
  els.alert.textContent = message;
  els.alert.hidden = !message;
}

async function start(mode) {
  commitTagInput();
  showAlert('');
  if (mode === 'video') {
    els.startVideo.setAttribute('aria-busy', 'true');
    try {
      await camera.acquire('meet');
    } catch (err) {
      showAlert(cameraErrorMessage(err));
      return;
    } finally {
      els.startVideo.removeAttribute('aria-busy');
    }
  } else {
    camera.release('meet');
  }
  state.mode = mode;
  state.live = true;
  els.lobby.hidden = true;
  els.live.hidden = false;
  els.videos.hidden = mode !== 'video';
  els.live.classList.toggle('is-video', mode === 'video');
  document.getElementById('app').classList.add('is-live');
  bus.emit('meet_live', true);
  clearLog();
  find();
}

function leave({ silent = false } = {}) {
  if (!silent && state.status === 'chatting' && !window.confirm('Leave this chat?')) return false;
  clearTimeout(state.autoTimer);
  state.seq += 1;
  socket.emit('leave');
  closePeer();
  camera.release('meet');
  setStatus('idle');
  clearLog();
  state.live = false;
  els.live.hidden = true;
  els.lobby.hidden = false;
  els.filterStrip.hidden = true;
  els.filtersBtn.setAttribute('aria-pressed', 'false');
  document.getElementById('app').classList.remove('is-live');
  bus.emit('meet_live', false);
  return true;
}

function find() {
  clearTimeout(state.autoTimer);
  closePeer();
  setStatus('searching');
  state.seq += 1;
  socket.emit('find', {
    seq: state.seq,
    mode: state.mode,
    interests: state.interests,
    randomFallback: els.fallback.checked,
  });
}

function scheduleAutoNext() {
  if (!els.autoNext.checked) return;
  clearTimeout(state.autoTimer);
  state.autoTimer = setTimeout(() => {
    if (state.live && state.status === 'ended') find();
  }, AUTO_NEXT_DELAY_MS);
}

function setStatus(status) {
  state.status = status;
  resetSkipConfirm();
  showTyping(false);
  if (status !== 'chatting') stopTyping();

  const chatting = status === 'chatting';
  els.input.disabled = !chatting;
  els.send.disabled = !chatting || !els.input.value.trim();
  els.report.disabled = !chatting;
  els.snap.disabled = !chatting;
  els.input.placeholder = chatting
    ? 'Type a message…'
    : status === 'searching'
      ? 'Waiting for a stranger…'
      : 'Press New to start chatting';

  if (!chatting) {
    state.addState = 'idle';
    state.partnerName = null;
    state.partnerFriendId = null;
  }
  els.remoteTag.textContent = state.partnerName || 'Stranger';
  els.typingWho.textContent = state.partnerName || 'Stranger';
  renderAddButton();

  els.statusDot.className = 'status__dot';
  if (status === 'searching') els.statusDot.classList.add('is-searching');
  if (chatting) els.statusDot.classList.add('is-chatting');
  els.statusText.textContent = {
    idle: 'Not connected',
    searching: 'Looking for a stranger…',
    chatting: 'Connected',
    ended: 'Chat ended',
  }[status];

  renderNextButton();
  renderRemoteOverlay();
}

function renderAddButton() {
  const btn = els.addBtn;
  btn.classList.remove('is-incoming', 'is-done');
  btn.disabled = state.status !== 'chatting' || state.addState === 'waiting' || state.addState === 'friends';
  const labels = { idle: 'Add friend', waiting: 'Requested', incoming: 'Add back', friends: 'Friends' };
  els.addLabel.textContent = labels[state.addState];
  if (state.addState === 'incoming') btn.classList.add('is-incoming');
  if (state.addState === 'friends') btn.classList.add('is-done');
}

async function addFriend() {
  if (state.status !== 'chatting') return;
  const res = await ask('stranger_add');
  if (!res.ok) {
    toast(res.error === 'self' ? "That's you in another tab!" : errorText(res.error));
    return;
  }
  if (res.status === 'waiting') {
    state.addState = 'waiting';
    renderAddButton();
    addSystem("Friend request sent. If they tap Add friend too, you'll swap usernames.");
  }
}

function renderNextButton() {
  const btn = els.next;
  btn.classList.remove('is-stop', 'is-confirm');
  let label = 'New';
  let title = 'Find a new stranger';
  if (state.status === 'searching') {
    label = 'Stop';
    title = 'Stop searching';
    btn.classList.add('is-stop');
  } else if (state.status === 'chatting') {
    label = state.confirmSkip ? 'Sure?' : 'Next';
    title = state.confirmSkip ? 'Click again to skip' : 'Skip to the next stranger';
    if (state.confirmSkip) btn.classList.add('is-confirm');
  }
  els.nextLabel.textContent = label;
  btn.title = `${title} (Esc)`;
}

function resetSkipConfirm() {
  state.confirmSkip = false;
  clearTimeout(state.confirmTimer);
}

function onNext() {
  clearTimeout(state.autoTimer);
  if (state.status === 'searching') {
    state.seq += 1;
    socket.emit('leave');
    setStatus('ended');
    clearLog();
    addSystem('You stopped searching.');
    return;
  }
  if (state.status === 'chatting' && !state.confirmSkip) {
    state.confirmSkip = true;
    renderNextButton();
    state.confirmTimer = setTimeout(() => {
      state.confirmSkip = false;
      renderNextButton();
    }, SKIP_CONFIRM_MS);
    return;
  }
  find();
}

// ---------- log ----------

function isNearBottom() {
  const { scrollTop, scrollHeight, clientHeight } = els.log;
  return scrollHeight - scrollTop - clientHeight < 80;
}

function appendRow(node) {
  const stick = isNearBottom();
  els.log.append(node);
  if (stick) els.log.scrollTop = els.log.scrollHeight;
  return node;
}

function clearLog() {
  els.log.replaceChildren();
}

function addSystem(text, variant) {
  return appendRow(h('div', { class: `sys${variant ? ` sys--${variant}` : ''}` }, h('span', { text })));
}

function addMessage(who, text) {
  const label = who === 'you' ? 'You:' : `${state.partnerName || 'Stranger'}:`;
  return appendRow(
    h('div', { class: `msg msg--${who}` }, h('span', { class: 'msg__who', text: label }), h('span', { class: 'msg__text', text })),
  );
}

function showTyping(on) {
  const stick = isNearBottom();
  els.typing.hidden = !on;
  if (on && stick) els.log.scrollTop = els.log.scrollHeight;
}

function sendMessage() {
  const text = els.input.value.trim();
  if (!text || state.status !== 'chatting') return;
  const row = addMessage('you', text);
  els.log.scrollTop = els.log.scrollHeight;
  els.input.value = '';
  autosize(els.input);
  stopTyping();
  els.send.disabled = true;
  socket.timeout(8000).emit('message', { text }, (err, res) => {
    if (!err && res && res.ok) return;
    row.classList.add('msg--failed');
    row.append(h('span', { class: 'msg__note', text: res && res.error === 'rate_limited' ? 'Slow down — not sent' : 'Not delivered' }));
  });
}

function stopTyping() {
  clearTimeout(state.typingTimer);
  if (state.sentTyping) {
    state.sentTyping = false;
    socket.emit('typing', false);
  }
}

function onInput() {
  autosize(els.input);
  const hasText = Boolean(els.input.value.trim());
  els.send.disabled = state.status !== 'chatting' || !hasText;
  if (state.status !== 'chatting') return;
  if (!hasText) return stopTyping();
  if (!state.sentTyping) {
    state.sentTyping = true;
    socket.emit('typing', true);
  }
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(stopTyping, TYPING_IDLE_MS);
}

function notify(text) {
  if (currentTab() !== 'meet') bus.emit('badge', { tab: 'meet', on: true });
  if (document.visibilityState !== 'hidden') return;
  state.unread += 1;
  document.title = `(${state.unread}) ${text} — the mog`;
}

// ---------- interests ----------

function makeTag(text) {
  const remove = h('button', { class: 'tag__remove', type: 'button', 'aria-label': `Remove ${text}` }, icon('x'));
  remove.addEventListener('click', (e) => {
    e.stopPropagation();
    state.interests = state.interests.filter((t) => t !== text);
    renderInterests();
    els.tagInput.focus();
  });
  return h('li', { class: 'tag' }, h('span', { class: 'tag__text', text }), remove);
}

function addInterest(raw) {
  const tag = raw.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 32).trim();
  if (!tag || state.interests.includes(tag)) return;
  if (state.interests.length >= config.maxInterests) {
    showAlert(`You can add up to ${config.maxInterests} interests.`);
    return;
  }
  state.interests.push(tag);
  renderInterests();
}

function renderInterests() {
  els.tagList.replaceChildren(...state.interests.map(makeTag));
  els.tagInput.placeholder = state.interests.length ? 'Add another…' : 'music, gaming, anime… press Enter';
  prefs.set('interests', state.interests);
}

function commitTagInput() {
  const value = els.tagInput.value;
  if (!value.trim()) return;
  value.split(',').forEach(addInterest);
  els.tagInput.value = '';
}

// ---------- WebRTC ----------

function startPeer(initiator) {
  closePeer();
  const pc = new RTCPeerConnection({ iceServers: config.iceServers });
  state.pc = pc;
  state.pendingCandidates = [];

  const tracks = [camera.videoTrack, camera.audioTrack].filter(Boolean);
  const stream = new MediaStream(tracks);
  for (const track of tracks) {
    const sender = pc.addTrack(track, stream);
    if (track.kind === 'video') state.videoSender = sender;
  }

  const remoteStream = new MediaStream();
  els.remoteVideo.srcObject = remoteStream;
  pc.ontrack = (event) => {
    if (state.pc !== pc) return;
    remoteStream.addTrack(event.track);
    els.remoteVideo.play().catch(() => {});
  };
  pc.onicecandidate = (event) => {
    if (state.pc === pc && event.candidate) socket.emit('signal', { candidate: event.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => {
    if (state.pc !== pc) return;
    renderRemoteOverlay();
    if (pc.connectionState === 'failed') {
      addSystem("Couldn't connect video with this stranger (network blocked). Text chat still works — or press Next.");
    }
  };
  renderRemoteOverlay();

  if (initiator) {
    (async () => {
      try {
        const offer = await pc.createOffer();
        if (state.pc !== pc) return;
        await pc.setLocalDescription(offer);
        socket.emit('signal', { description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
      } catch (err) {
        console.warn('Could not create offer', err);
      }
    })();
  }
}

async function handleSignal(pc, data) {
  if (state.pc !== pc || !data) return;
  try {
    if (data.description) {
      await pc.setRemoteDescription(data.description);
      if (state.pc !== pc) return;
      for (const c of state.pendingCandidates.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      if (data.description.type === 'offer') {
        const answer = await pc.createAnswer();
        if (state.pc !== pc) return;
        await pc.setLocalDescription(answer);
        socket.emit('signal', { description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
      }
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else state.pendingCandidates.push(data.candidate);
    }
  } catch (err) {
    console.warn('Signalling error', err);
  }
}

function closePeer() {
  const pc = state.pc;
  state.pc = null;
  state.videoSender = null;
  state.pendingCandidates = [];
  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    try {
      pc.close();
    } catch {
      /* already closed */
    }
  }
  els.remoteVideo.srcObject = null;
  renderRemoteOverlay();
}

function renderRemoteOverlay() {
  if (state.mode !== 'video') return;
  let text = null;
  let busy = false;
  const conn = state.pc && state.pc.connectionState;
  if (state.status === 'searching') {
    text = 'Looking for a stranger…';
    busy = true;
  } else if (state.status === 'chatting') {
    if (conn === 'failed') text = "Video couldn't connect";
    else if (conn === 'disconnected') {
      text = 'Connection unstable…';
      busy = true;
    } else if (conn !== 'connected') {
      text = 'Connecting video…';
      busy = true;
    }
  } else if (state.status === 'ended') {
    text = 'Press New to meet someone';
  } else {
    text = 'Not connected';
  }
  els.remoteOverlay.hidden = text === null;
  els.remoteOverlay.classList.toggle('is-idle', !busy);
  if (text) els.remoteStatus.textContent = text;
}

function toggleTrack(kind, button, onIcon, offIcon, labels) {
  const off = button.getAttribute('aria-pressed') !== 'true';
  const tracks = camera.raw ? (kind === 'audio' ? camera.raw.getAudioTracks() : camera.raw.getVideoTracks()) : [];
  tracks.forEach((t) => (t.enabled = !off));
  button.setAttribute('aria-pressed', String(off));
  button.setAttribute('aria-label', off ? labels[1] : labels[0]);
  button.title = off ? labels[1] : labels[0];
  button.querySelector('use').setAttribute('href', off ? offIcon : onIcon);
  if (kind === 'video') els.localTile.classList.toggle('is-cam-off', off);
}

// ---------- init ----------

export function initMeet() {
  Object.assign(els, {
    lobby: $('#meet-lobby'),
    live: $('#meet-live'),
    alert: $('#meet-alert'),
    tagBox: $('#tag-box'),
    tagList: $('#tag-list'),
    tagInput: $('#tag-input'),
    fallback: $('#fallback'),
    startText: $('#start-text'),
    startVideo: $('#start-video'),
    videos: $('#videos'),
    remoteVideo: $('#remote-video'),
    remoteOverlay: $('#remote-overlay'),
    remoteStatus: $('#remote-status'),
    remoteTag: $('#remote-tag'),
    localVideo: $('#local-video'),
    localTile: $('.tile--local'),
    filtersBtn: $('#meet-filters-btn'),
    filterStrip: $('#meet-filters'),
    toggleMic: $('#toggle-mic'),
    toggleCam: $('#toggle-cam'),
    leave: $('#meet-leave'),
    statusDot: $('#status-dot'),
    statusText: $('#status-text'),
    addBtn: $('#stranger-add'),
    addLabel: $('#stranger-add-label'),
    autoNext: $('#auto-next'),
    report: $('#report'),
    log: $('#log'),
    typing: $('#typing'),
    typingWho: $('#typing-who'),
    composer: $('#composer'),
    input: $('#message'),
    send: $('#send'),
    next: $('#next'),
    nextLabel: $('#next-label'),
    snap: $('#meet-snap'),
    reportDialog: $('#report-dialog'),
    reportForm: $('#report-form'),
  });

  bindSocket();
  bindPreview(els.localVideo);
  filterStrip(els.filterStrip);
  camera.addEventListener('change', () => {
    if (state.videoSender && camera.videoTrack && state.videoSender.track !== camera.videoTrack) {
      state.videoSender.replaceTrack(camera.videoTrack).catch(() => {});
    }
  });

  els.tagBox.addEventListener('click', () => els.tagInput.focus());
  els.tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitTagInput();
    } else if (e.key === 'Backspace' && !els.tagInput.value && state.interests.length) {
      state.interests.pop();
      renderInterests();
    }
  });
  els.tagInput.addEventListener('blur', commitTagInput);
  els.tagInput.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') || '';
    if (text.includes(',')) {
      e.preventDefault();
      text.split(',').forEach(addInterest);
    }
  });

  els.fallback.addEventListener('change', () => prefs.set('fallback', els.fallback.checked));
  els.autoNext.addEventListener('change', () => prefs.set('autoNext', els.autoNext.checked));
  els.startText.addEventListener('click', () => start('text'));
  els.startVideo.addEventListener('click', () => start('video'));
  els.leave.addEventListener('click', () => leave());
  els.next.addEventListener('click', onNext);
  els.addBtn.addEventListener('click', addFriend);
  els.snap.addEventListener('click', () => snapTo({ type: 'stranger' }, 'meet'));
  els.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage();
  });
  els.input.addEventListener('input', onInput);
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !state.live || currentTab() !== 'meet' || overlayOpen()) return;
    e.preventDefault();
    onNext();
  });

  els.filtersBtn.addEventListener('click', () => {
    const open = els.filterStrip.hidden;
    els.filterStrip.hidden = !open;
    els.filtersBtn.setAttribute('aria-pressed', String(open));
  });
  els.toggleMic.addEventListener('click', () =>
    toggleTrack('audio', els.toggleMic, '#i-mic', '#i-mic-off', ['Mute microphone', 'Unmute microphone']),
  );
  els.toggleCam.addEventListener('click', () =>
    toggleTrack('video', els.toggleCam, '#i-cam', '#i-cam-off', ['Turn camera off', 'Turn camera on']),
  );

  els.report.addEventListener('click', () => {
    if (state.status === 'chatting') els.reportDialog.showModal();
  });
  els.reportDialog.addEventListener('close', () => {
    if (els.reportDialog.returnValue !== 'report' || state.status !== 'chatting') return;
    const reason = new FormData(els.reportForm).get('reason') || 'other';
    state.seq += 1;
    ask('report', { reason });
    closePeer();
    setStatus('ended');
    clearLog();
    addSystem('Thanks — the stranger was reported and disconnected.', 'strong');
    scheduleAutoNext();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.unread) {
      state.unread = 0;
      bus.emit('retitle');
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.status === 'chatting') {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  state.interests = (prefs.get('interests', []) || []).filter((t) => typeof t === 'string').slice(0, config.maxInterests);
  els.fallback.checked = prefs.get('fallback', true) !== false;
  els.autoNext.checked = prefs.get('autoNext', false) === true;
  renderInterests();
  setStatus('idle');
}
