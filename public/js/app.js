/* global io */
(() => {
  'use strict';

  const SITE_NAME = 'the mog';
  const MAX_INTERESTS = 10;
  const SKIP_CONFIRM_MS = 3000;
  const AUTO_NEXT_DELAY_MS = 1500;
  const TYPING_IDLE_MS = 3000;

  const $ = (sel) => document.querySelector(sel);
  const els = {
    home: $('#home'),
    chat: $('#chat'),
    homeAlert: $('#home-alert'),
    tagBox: $('#tag-box'),
    tagList: $('#tag-list'),
    tagInput: $('#tag-input'),
    fallback: $('#fallback'),
    agree: $('#agree'),
    agreeRow: $('#agree-row'),
    startText: $('#start-text'),
    startVideo: $('#start-video'),
    chatHome: $('#chat-home'),
    modePill: $('#mode-pill'),
    chatMain: $('#chat-main'),
    videos: $('#videos'),
    remoteVideo: $('#remote-video'),
    remoteOverlay: $('#remote-overlay'),
    remoteStatus: $('#remote-status'),
    localVideo: $('#local-video'),
    localTile: document.querySelector('.tile--local'),
    toggleMic: $('#toggle-mic'),
    toggleCam: $('#toggle-cam'),
    statusDot: $('#status-dot'),
    statusText: $('#status-text'),
    autoNext: $('#auto-next'),
    report: $('#report'),
    log: $('#log'),
    typing: $('#typing'),
    composer: $('#composer'),
    input: $('#message'),
    send: $('#send'),
    next: $('#next'),
    nextLabel: $('#next-label'),
    reportDialog: $('#report-dialog'),
    reportForm: $('#report-form'),
  };

  const state = {
    view: 'home',
    mode: 'text',
    interests: [],
    status: 'idle', // idle | searching | chatting | ended
    confirmSkip: false,
    confirmTimer: null,
    autoTimer: null,
    typingTimer: null,
    sentTyping: false,
    unread: 0,
    iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    localStream: null,
    pc: null,
    pendingCandidates: [],
    signalQueue: Promise.resolve(),
    wasConnected: false,
    seq: 0, // bumped whenever we abandon a search/chat; stale server events are ignored
  };

  // ---------- Storage (best effort) ----------

  const store = {
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
        /* storage unavailable */
      }
    },
  };

  // ---------- Socket ----------

  const socket = io({ autoConnect: true });

  fetch('/api/config')
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => {
      if (!cfg) return;
      if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) state.iceServers = cfg.iceServers;
      if (cfg.maxMessageLength) els.input.maxLength = cfg.maxMessageLength;
    })
    .catch(() => {});

  socket.on('online', (count) => {
    const text = Number(count).toLocaleString();
    document.querySelectorAll('[data-online]').forEach((el) => {
      el.textContent = text;
    });
  });

  socket.on('connect', () => {
    if (state.wasConnected && state.view === 'chat') {
      addSystem('Reconnected. Press New to find someone.');
    }
    state.wasConnected = true;
  });

  socket.on('disconnect', () => {
    if (state.view !== 'chat') return;
    if (state.status === 'searching' || state.status === 'chatting') {
      closePeer();
      setStatus('ended');
      addSystem('Lost connection to the server. Trying to reconnect…', 'strong');
    }
  });

  socket.on('searching', ({ interests, seq }) => {
    if (seq !== state.seq || state.status !== 'searching') return;
    clearLog();
    const row = addSystem(
      interests && interests.length
        ? `Looking for someone into ${formatList(interests)}`
        : 'Looking for someone you can chat with',
    );
    row.classList.add('sys--searching');
  });

  socket.on('matched', ({ mode, common, initiator, seq }) => {
    if (seq !== state.seq || state.status !== 'searching') return;
    clearLog();
    setStatus('chatting');

    const hello = addSystem("You're now chatting with a random stranger. Say hi!", 'hello');
    if (common && common.length) {
      const note = document.createElement('div');
      note.textContent = 'You both like:';
      note.className = 'sys__label';
      const tags = document.createElement('div');
      tags.className = 'sys__tags';
      common.forEach((t) => tags.append(makeTag(t)));
      hello.append(note, tags);
    } else if (state.interests.length) {
      addSystem("Nobody shared your interests right now, so here's a random stranger.");
    }

    if (mode === 'video' && state.localStream) startPeer(initiator);
    if (!isTouch()) els.input.focus();
    notify('Connected to a stranger');
  });

  socket.on('message', ({ text }) => {
    if (state.status !== 'chatting') return;
    showTyping(false);
    addMessage('stranger', text);
    notify('New message');
  });

  socket.on('typing', (isTyping) => showTyping(Boolean(isTyping) && state.status === 'chatting'));

  socket.on('partner_left', () => {
    if (state.status !== 'chatting') return;
    closePeer();
    setStatus('ended');
    addSystem('Stranger has disconnected.', 'strong');
    notify('Stranger disconnected');
    if (els.autoNext.checked) {
      clearTimeout(state.autoTimer);
      state.autoTimer = setTimeout(() => {
        if (state.view === 'chat' && state.status === 'ended') find();
      }, AUTO_NEXT_DELAY_MS);
    }
  });

  socket.on('signal', (data) => {
    const pc = state.pc;
    if (!pc) return;
    state.signalQueue = state.signalQueue.then(() => handleSignal(pc, data)).catch(() => {});
  });

  socket.on('banned', ({ remainingMs }) => {
    const mins = Math.max(1, Math.ceil((remainingMs || 0) / 60000));
    leaveChat({ silent: true });
    showHomeAlert(
      `You've been temporarily blocked after several reports from other people. Try again in about ${mins} minute${mins === 1 ? '' : 's'}.`,
    );
  });

  // ---------- Views ----------

  function showChat(mode) {
    state.view = 'chat';
    state.mode = mode;
    els.home.hidden = true;
    els.chat.hidden = false;
    const isVideo = mode === 'video';
    els.videos.hidden = !isVideo;
    els.chatMain.classList.toggle('is-video', isVideo);
    els.modePill.textContent = isVideo ? 'Video chat' : 'Text chat';
    document.title = `${isVideo ? 'Video' : 'Text'} chat — ${SITE_NAME}`;
    if (location.hash !== `#${mode}`) history.pushState({ view: 'chat', mode }, '', `#${mode}`);
  }

  function showHome() {
    state.view = 'home';
    els.chat.hidden = true;
    els.home.hidden = false;
    document.title = `${SITE_NAME} — talk to strangers`;
    if (location.hash) history.pushState({ view: 'home' }, '', location.pathname);
  }

  function leaveChat({ silent = false } = {}) {
    if (!silent && state.status === 'chatting' && !window.confirm('Leave this chat?')) return false;
    clearTimeout(state.autoTimer);
    state.seq += 1;
    socket.emit('leave');
    closePeer();
    stopLocalStream();
    setStatus('idle');
    clearLog();
    showHome();
    return true;
  }

  function showHomeAlert(message) {
    els.homeAlert.textContent = message;
    els.homeAlert.hidden = !message;
  }

  // ---------- Status & controls ----------

  function setStatus(status) {
    state.status = status;
    resetSkipConfirm();
    showTyping(false);
    if (status !== 'chatting') stopTyping();

    const chatting = status === 'chatting';
    els.input.disabled = !chatting;
    els.send.disabled = !chatting || !els.input.value.trim();
    els.report.disabled = !chatting;
    els.input.placeholder = chatting ? 'Type a message…' : status === 'searching' ? 'Waiting for a stranger…' : 'Press New to start chatting';

    els.statusDot.className = 'status__dot';
    if (status === 'searching') els.statusDot.classList.add('is-searching');
    if (chatting) els.statusDot.classList.add('is-chatting');
    els.statusText.textContent = {
      idle: 'Not connected',
      searching: 'Looking for a stranger…',
      chatting: 'Connected to a stranger',
      ended: 'Chat ended',
    }[status];

    renderNextButton();
    renderRemoteOverlay();
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
      if (state.confirmSkip) {
        label = 'Sure?';
        title = 'Click again to skip';
        btn.classList.add('is-confirm');
      } else {
        label = 'Next';
        title = 'Skip to the next stranger';
      }
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
    if (state.status === 'chatting') {
      if (!state.confirmSkip) {
        state.confirmSkip = true;
        renderNextButton();
        state.confirmTimer = setTimeout(() => {
          state.confirmSkip = false;
          renderNextButton();
        }, SKIP_CONFIRM_MS);
        return;
      }
      find();
      return;
    }
    find();
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

  async function start(mode) {
    commitTagInput();
    showHomeAlert('');
    if (!els.agree.checked) {
      els.agreeRow.classList.remove('is-flagged');
      void els.agreeRow.offsetWidth; // restart the animation
      els.agreeRow.classList.add('is-flagged');
      els.agree.focus();
      return;
    }
    store.set('agreed', true);

    if (mode === 'video') {
      const btn = els.startVideo;
      btn.setAttribute('aria-busy', 'true');
      try {
        await ensureLocalStream();
      } catch (err) {
        showHomeAlert(cameraErrorMessage(err));
        return;
      } finally {
        btn.removeAttribute('aria-busy');
      }
    } else {
      stopLocalStream();
    }

    showChat(mode);
    clearLog();
    find();
  }

  // ---------- Chat log ----------

  function isNearBottom() {
    const { scrollTop, scrollHeight, clientHeight } = els.log;
    return scrollHeight - scrollTop - clientHeight < 80;
  }

  function append(node) {
    const stick = isNearBottom();
    els.log.append(node);
    if (stick) els.log.scrollTop = els.log.scrollHeight;
    return node;
  }

  function clearLog() {
    els.log.replaceChildren();
  }

  function addSystem(text, variant) {
    const row = document.createElement('div');
    row.className = `sys${variant ? ` sys--${variant}` : ''}`;
    const span = document.createElement('span');
    span.textContent = text;
    row.append(span);
    return append(row);
  }

  function addMessage(who, text) {
    const row = document.createElement('div');
    row.className = `msg msg--${who}`;
    const label = document.createElement('span');
    label.className = 'msg__who';
    label.textContent = who === 'you' ? 'You:' : 'Stranger:';
    const body = document.createElement('span');
    body.className = 'msg__text';
    body.textContent = text;
    row.append(label, body);
    return append(row);
  }

  function markFailed(row, reason) {
    row.classList.add('msg--failed');
    const note = document.createElement('span');
    note.className = 'msg__note';
    note.textContent = reason === 'rate_limited' ? 'Slow down — not sent' : 'Not delivered';
    row.append(note);
  }

  function showTyping(on) {
    const stick = isNearBottom();
    els.typing.hidden = !on;
    if (on && stick) els.log.scrollTop = els.log.scrollHeight;
  }

  // ---------- Sending & typing ----------

  function sendMessage() {
    const text = els.input.value.trim();
    if (!text || state.status !== 'chatting') return;
    const row = addMessage('you', text);
    els.log.scrollTop = els.log.scrollHeight;
    els.input.value = '';
    autosize();
    stopTyping();
    els.send.disabled = true;
    socket.timeout(8000).emit('message', { text }, (err, res) => {
      if (err || !res || !res.ok) markFailed(row, res && res.error);
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
    autosize();
    const hasText = Boolean(els.input.value.trim());
    els.send.disabled = state.status !== 'chatting' || !hasText;
    if (state.status !== 'chatting') return;
    if (!hasText) {
      stopTyping();
      return;
    }
    if (!state.sentTyping) {
      state.sentTyping = true;
      socket.emit('typing', true);
    }
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(stopTyping, TYPING_IDLE_MS);
  }

  function autosize() {
    els.input.style.height = 'auto';
    els.input.style.height = `${Math.min(els.input.scrollHeight + 3, 160)}px`;
  }

  // ---------- Interests ----------

  function makeTag(text, removable = false) {
    const li = document.createElement(removable ? 'li' : 'span');
    li.className = 'tag';
    const label = document.createElement('span');
    label.className = 'tag__text';
    label.textContent = text;
    li.append(label);
    if (removable) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tag__remove';
      btn.setAttribute('aria-label', `Remove ${text}`);
      btn.innerHTML = '<svg aria-hidden="true"><use href="#i-x"/></svg>';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeInterest(text);
        els.tagInput.focus();
      });
      li.append(btn);
    }
    return li;
  }

  function normalizeTag(raw) {
    return raw.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 32).trim();
  }

  function addInterest(raw) {
    const tag = normalizeTag(raw);
    if (!tag || state.interests.includes(tag)) return;
    if (state.interests.length >= MAX_INTERESTS) {
      showHomeAlert(`You can add up to ${MAX_INTERESTS} interests.`);
      return;
    }
    state.interests.push(tag);
    renderInterests();
  }

  function removeInterest(tag) {
    state.interests = state.interests.filter((t) => t !== tag);
    renderInterests();
  }

  function renderInterests() {
    els.tagList.replaceChildren(...state.interests.map((t) => makeTag(t, true)));
    els.tagInput.placeholder = state.interests.length ? 'Add another…' : 'music, gaming, anime… press Enter';
    store.set('interests', state.interests);
  }

  function commitTagInput() {
    const value = els.tagInput.value;
    if (!value.trim()) return;
    value.split(',').forEach(addInterest);
    els.tagInput.value = '';
  }

  // ---------- Media / WebRTC ----------

  async function ensureLocalStream() {
    if (state.localStream && state.localStream.getTracks().some((t) => t.readyState === 'live')) {
      return state.localStream;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const err = new Error('getUserMedia unavailable');
      err.name = window.isSecureContext ? 'NotSupportedError' : 'InsecureContext';
      throw err;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    state.localStream = stream;
    els.localVideo.srcObject = stream;
    setMicMuted(false);
    setCamOff(false);
    return stream;
  }

  function stopLocalStream() {
    if (state.localStream) {
      state.localStream.getTracks().forEach((t) => t.stop());
      state.localStream = null;
    }
    els.localVideo.srcObject = null;
  }

  function cameraErrorMessage(err) {
    switch (err && err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Camera and microphone access was blocked. Allow access in your browser settings to use video chat, or try text chat.';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return "We couldn't find a camera or microphone. Plug one in, or try text chat.";
      case 'NotReadableError':
        return 'Your camera is being used by another app. Close it and try again.';
      case 'InsecureContext':
        return 'Video chat needs a secure (https) connection.';
      default:
        return "Video chat isn't available in this browser. Try text chat instead.";
    }
  }

  function startPeer(initiator) {
    closePeer();
    const pc = new RTCPeerConnection({ iceServers: state.iceServers });
    state.pc = pc;
    state.pendingCandidates = [];

    state.localStream.getTracks().forEach((track) => pc.addTrack(track, state.localStream));

    const remoteStream = new MediaStream();
    els.remoteVideo.srcObject = remoteStream;

    pc.ontrack = (event) => {
      if (state.pc !== pc) return;
      remoteStream.addTrack(event.track);
      els.remoteVideo.play().catch(() => {});
    };

    pc.onicecandidate = (event) => {
      if (state.pc !== pc || !event.candidate) return;
      socket.emit('signal', { candidate: event.candidate.toJSON() });
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
        const queued = state.pendingCandidates.splice(0);
        for (const c of queued) await pc.addIceCandidate(c).catch(() => {});
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
      if (conn === 'connected') text = null;
      else if (conn === 'failed') text = "Video couldn't connect";
      else if (conn === 'disconnected') {
        text = 'Connection unstable…';
        busy = true;
      } else {
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

  function setMicMuted(muted) {
    if (state.localStream) state.localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
    els.toggleMic.setAttribute('aria-pressed', String(muted));
    const label = muted ? 'Unmute microphone' : 'Mute microphone';
    els.toggleMic.setAttribute('aria-label', label);
    els.toggleMic.title = label;
    els.toggleMic.querySelector('use').setAttribute('href', muted ? '#i-mic-off' : '#i-mic');
  }

  function setCamOff(off) {
    if (state.localStream) state.localStream.getVideoTracks().forEach((t) => (t.enabled = !off));
    els.toggleCam.setAttribute('aria-pressed', String(off));
    const label = off ? 'Turn camera on' : 'Turn camera off';
    els.toggleCam.setAttribute('aria-label', label);
    els.toggleCam.title = label;
    els.toggleCam.querySelector('use').setAttribute('href', off ? '#i-cam-off' : '#i-cam');
    els.localTile.classList.toggle('is-cam-off', off);
  }

  // ---------- Notifications in the tab title ----------

  function notify(text) {
    if (document.visibilityState !== 'hidden') return;
    state.unread += 1;
    document.title = `(${state.unread}) ${text} — ${SITE_NAME}`;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.unread) {
      state.unread = 0;
      document.title = state.view === 'chat'
        ? `${state.mode === 'video' ? 'Video' : 'Text'} chat — ${SITE_NAME}`
        : `${SITE_NAME} — talk to strangers`;
    }
  });

  // ---------- Helpers ----------

  function formatList(items) {
    if (items.length <= 1) return items.join('');
    return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
  }

  function isTouch() {
    return window.matchMedia('(pointer: coarse)').matches;
  }

  // ---------- Wire up events ----------

  els.tagBox.addEventListener('click', () => els.tagInput.focus());
  els.tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitTagInput();
    } else if (e.key === 'Backspace' && !els.tagInput.value && state.interests.length) {
      removeInterest(state.interests[state.interests.length - 1]);
    }
  });
  els.tagInput.addEventListener('blur', commitTagInput);
  els.tagInput.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
    if (text.includes(',')) {
      e.preventDefault();
      text.split(',').forEach(addInterest);
    }
  });

  els.agree.addEventListener('change', () => {
    if (els.agree.checked) els.agreeRow.classList.remove('is-flagged');
  });
  els.fallback.addEventListener('change', () => store.set('fallback', els.fallback.checked));
  els.autoNext.addEventListener('change', () => store.set('autoNext', els.autoNext.checked));

  els.startText.addEventListener('click', () => start('text'));
  els.startVideo.addEventListener('click', () => start('video'));

  els.chatHome.addEventListener('click', (e) => {
    e.preventDefault();
    leaveChat();
  });

  els.next.addEventListener('click', onNext);
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
    if (e.key !== 'Escape' || state.view !== 'chat' || els.reportDialog.open) return;
    e.preventDefault();
    onNext();
  });

  els.toggleMic.addEventListener('click', () => {
    setMicMuted(els.toggleMic.getAttribute('aria-pressed') !== 'true');
  });
  els.toggleCam.addEventListener('click', () => {
    setCamOff(els.toggleCam.getAttribute('aria-pressed') !== 'true');
  });

  els.report.addEventListener('click', () => {
    if (state.status !== 'chatting') return;
    if (typeof els.reportDialog.showModal === 'function') els.reportDialog.showModal();
  });
  els.reportDialog.addEventListener('close', () => {
    if (els.reportDialog.returnValue !== 'report' || state.status !== 'chatting') return;
    const reason = new FormData(els.reportForm).get('reason') || 'other';
    state.seq += 1;
    socket.timeout(8000).emit('report', { reason }, () => {});
    closePeer();
    setStatus('ended');
    clearLog();
    addSystem('Thanks — the stranger was reported and disconnected.', 'strong');
    if (els.autoNext.checked) {
      state.autoTimer = setTimeout(() => {
        if (state.view === 'chat' && state.status === 'ended') find();
      }, AUTO_NEXT_DELAY_MS);
    }
  });

  window.addEventListener('popstate', () => {
    if (state.view === 'chat' && !location.hash) {
      if (!leaveChat()) history.pushState({ view: 'chat', mode: state.mode }, '', `#${state.mode}`);
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.view === 'chat' && state.status === 'chatting') {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ---------- Init ----------

  state.interests = (store.get('interests', []) || []).filter((t) => typeof t === 'string').slice(0, MAX_INTERESTS);
  els.fallback.checked = store.get('fallback', true) !== false;
  els.autoNext.checked = store.get('autoNext', false) === true;
  els.agree.checked = store.get('agreed', false) === true;
  renderInterests();
  setStatus('idle');
  if (location.hash) history.replaceState({ view: 'home' }, '', location.pathname);
})();
