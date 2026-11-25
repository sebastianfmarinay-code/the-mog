// Onboarding (pick a look and username) and the Me tab.

import { ask, config, token } from './net.js';
import { $, h, paintAvatar, toast, errorText, plural, showError, bus, timeAgo, formatList } from './ui.js';
import { social } from './social.js';
import { storyFeed, loadStories, playMyStory } from './stories.js';

const ADJECTIVES = ['sleepy', 'cosmic', 'lucky', 'fuzzy', 'sneaky', 'mellow', 'spicy', 'tiny', 'brave', 'chill', 'glitchy', 'sunny', 'witty', 'zesty', 'quiet', 'neon'];
const NOUNS = ['otter', 'panda', 'comet', 'pickle', 'waffle', 'fox', 'yeti', 'moth', 'cactus', 'koala', 'pixel', 'noodle', 'falcon', 'gecko', 'mango', 'raven'];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const randomName = () => `${pick(ADJECTIVES)}${pick(NOUNS)}${Math.floor(10 + Math.random() * 90)}`;
const cleanName = (v) => v.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_.]/g, '').slice(0, 20);

function lookPicker(emojiBox, colorBox, current, onChange) {
  const look = { ...current };
  const render = () => {
    emojiBox.replaceChildren(
      ...config.avatars.emojis.map((emoji) => {
        const btn = h('button', { class: 'emoji-choice', type: 'button', 'aria-label': `Avatar ${emoji}`, 'aria-pressed': String(look.emoji === emoji), text: emoji });
        btn.addEventListener('click', () => {
          look.emoji = emoji;
          render();
          onChange({ ...look });
        });
        return btn;
      }),
    );
    colorBox.replaceChildren(
      ...config.avatars.colors.map((color) => {
        const btn = h('button', { class: 'color-choice', type: 'button', 'aria-label': `Colour ${color}`, 'aria-pressed': String(look.color === color) });
        btn.style.setProperty('--c', color);
        btn.addEventListener('click', () => {
          look.color = color;
          render();
          onChange({ ...look });
        });
        return btn;
      }),
    );
  };
  render();
  return {
    set(next) {
      Object.assign(look, next);
      render();
    },
  };
}

// ---------- onboarding ----------

/** Show the sign-up card. Resolves with the new user once registered. */
export function showOnboarding(notice) {
  const root = $('#onboarding');
  const form = $('#ob-form');
  const preview = $('#ob-avatar');
  const input = $('#ob-username');
  const hint = $('#ob-username-hint');
  const agree = $('#ob-agree');
  const agreeRow = $('#ob-agree-row');
  const error = $('#ob-error');
  const submit = $('#ob-submit');
  const noticeEl = $('#ob-notice');

  showError(noticeEl, notice || '');
  root.hidden = false;

  const look = { emoji: pick(config.avatars.emojis), color: pick(config.avatars.colors) };
  paintAvatar(preview, { avatar: look });
  lookPicker($('#ob-emojis'), $('#ob-colors'), look, (next) => {
    Object.assign(look, next);
    paintAvatar(preview, { avatar: look });
    preview.classList.remove('is-pop');
    void preview.offsetWidth;
    preview.classList.add('is-pop');
  });

  let checkTimer = null;
  let checkSeq = 0;
  const check = () => {
    clearTimeout(checkTimer);
    const name = input.value;
    hint.className = 'field-hint';
    if (name.length < 3) {
      hint.textContent = '3–20 characters: letters, numbers, _ and .';
      return;
    }
    hint.textContent = 'Checking…';
    const seq = ++checkSeq;
    checkTimer = setTimeout(async () => {
      const res = await ask('check_username', { username: name });
      if (seq !== checkSeq) return;
      if (!res.ok) return;
      if (!res.valid) {
        hint.textContent = errorText('invalid');
        hint.classList.add('is-bad');
      } else if (res.available) {
        hint.textContent = `@${name} is available`;
        hint.classList.add('is-good');
      } else {
        hint.textContent = `@${name} is taken`;
        hint.classList.add('is-bad');
      }
    }, 250);
  };

  input.value = randomName();
  check();
  input.addEventListener('input', () => {
    const cleaned = cleanName(input.value);
    if (cleaned !== input.value) input.value = cleaned;
    check();
  });
  $('#ob-shuffle').addEventListener('click', () => {
    input.value = randomName();
    check();
  });
  agree.addEventListener('change', () => agree.checked && agreeRow.classList.remove('is-flagged'));

  return new Promise((resolve) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError(error, '');
      if (!agree.checked) {
        agreeRow.classList.remove('is-flagged');
        void agreeRow.offsetWidth;
        agreeRow.classList.add('is-flagged');
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Creating…';
      const res = await ask('register', { username: input.value, avatar: look });
      submit.disabled = false;
      submit.textContent = "Let's go";
      if (!res.ok) {
        showError(error, errorText(res.error));
        return;
      }
      token.set(res.token);
      root.hidden = true;
      resolve(res.user);
    });
  });
}

// ---------- Me tab ----------

const els = {};
let picker = null;

function renderMe() {
  const me = social.me;
  if (!me) return;
  paintAvatar(els.avatar, me);
  els.name.textContent = `@${me.username}`;
  const best = Math.max(0, ...social.friends.map((f) => f.streak || 0));
  els.stats.textContent = [plural(social.friends.length, 'friend'), best ? `best streak 🔥 ${best}` : null].filter(Boolean).join(' · ');
  picker?.set(me.avatar);
  renderMyStories();
}

function renderMyStories() {
  const mine = storyFeed.mine;
  els.storiesEmpty.hidden = mine.length > 0;
  els.stories.replaceChildren(
    ...mine
      .slice()
      .reverse()
      .map((s) => {
        const views = s.views.length ? `${plural(s.views.length, 'view')}: ${formatList(s.views.slice(0, 4).map((v) => `@${v.username}`))}${s.views.length > 4 ? '…' : ''}` : 'No views yet';
        return h(
          'li',
          { class: 'me-story' },
          h('span', { class: 'me-story__text' }, h('strong', { text: `Posted ${timeAgo(s.at)}` }), h('span', { text: views })),
        );
      }),
  );
  if (mine.length) {
    els.stories.append(h('li', {}, h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Watch my story', onclick: () => playMyStory() })));
  }
}

async function saveLook(look) {
  const res = await ask('update_profile', { avatar: look });
  if (!res.ok) return toast(errorText(res.error));
  social.me = res.user;
  bus.emit('social');
}

export async function showMe() {
  renderMe();
  await loadStories();
  renderMe();
}

export function initMe() {
  Object.assign(els, {
    avatar: $('#me-avatar'),
    name: $('#me-name'),
    stats: $('#me-stats'),
    stories: $('#me-stories'),
    storiesEmpty: $('#me-stories-empty'),
    signout: $('#me-signout'),
  });
  picker = lookPicker($('#me-emojis'), $('#me-colors'), social.me?.avatar || {}, saveLook);
  els.signout.addEventListener('click', () => {
    if (!window.confirm('Sign out? There is no password, so you will lose this username, your friends and your streaks.')) return;
    token.clear();
    location.hash = '';
    location.reload();
  });
  bus.on('social', renderMe);
  bus.on('stories_loaded', renderMyStories);
}
