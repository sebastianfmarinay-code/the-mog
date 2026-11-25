// Entry point: connect, sign in or onboard, then run the tabbed app.

import { socket, token, loadConfig } from './net.js';
import { $, $$, bus, paintAvatar } from './ui.js';
import { social } from './social.js';
import { TABS, currentTab } from './nav.js';
import { initMeet } from './meet.js';
import { initCameraTab, showCameraTab, hideCameraTab } from './camtab.js';
import { initEditor } from './editor.js';
import { initChats, showChats } from './chats.js';
import { initStories, loadStories } from './stories.js';
import { initMe, showMe, showOnboarding } from './profile.js';

const TITLES = { meet: 'Meet', chats: 'Chats', camera: 'Camera', stories: 'Stories', me: 'Me' };

const app = $('#app');
let shownTab = null;
let entered = false;

function showTab(tab) {
  if (tab === shownTab) return;
  const prev = shownTab;
  shownTab = tab;

  if (prev === 'camera') hideCameraTab();
  app.dataset.tab = tab;
  for (const view of $$('.view')) view.hidden = view.dataset.view !== tab;
  for (const link of $$('.tab')) {
    if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  $('#top-title').textContent = TITLES[tab];
  retitle();

  if (tab === 'meet') setBadge({ tab: 'meet', on: false });
  if (tab === 'camera') showCameraTab();
  if (tab === 'chats') showChats();
  if (tab === 'stories') loadStories();
  if (tab === 'me') showMe();
}

function retitle() {
  document.title = shownTab === 'meet' || !shownTab ? 'the mog — meet, snap, repeat' : `${TITLES[shownTab]} — the mog`;
}

function setBadge({ tab, count, on }) {
  const badge = document.querySelector(`[data-badge="${tab}"]`);
  if (!badge) return;
  if (count !== undefined) {
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.hidden = !count;
  } else {
    badge.hidden = !on;
  }
}

async function enterApp(user) {
  social.me = user;
  await social.sync();
  if (entered) return; // reconnect: state refreshed, nothing else to do
  entered = true;
  $('#boot').hidden = true;
  $('#onboarding').hidden = true;
  app.hidden = false;
  if (!location.hash || !TABS.includes(location.hash.slice(1))) history.replaceState(null, '', '#meet');
  showTab(currentTab());
  loadStories();
}

async function boot() {
  await loadConfig();
  initMeet();
  initCameraTab();
  initEditor();
  initChats();
  initStories();
  initMe();

  window.addEventListener('hashchange', () => entered && showTab(currentTab()));
  bus.on('badge', setBadge);
  bus.on('retitle', retitle);
  bus.on('social', () => social.me && paintAvatar($('#top-avatar'), social.me));

  socket.on('online', (count) => {
    const text = Number(count).toLocaleString();
    $$('[data-online]').forEach((el) => (el.textContent = text));
  });

  socket.on('session', async ({ user }) => {
    if (user) return enterApp(user);
    if (entered) {
      // The server no longer knows this profile (e.g. its data was reset).
      token.clear();
      location.reload();
      return;
    }
    $('#boot').hidden = true;
    const notice = token.get()
      ? "We couldn't find your saved profile on this server, so make a new one."
      : '';
    token.clear();
    const created = await showOnboarding(notice);
    await enterApp(created);
  });

  socket.on('auth_required', () => location.reload());
  socket.on('connect_error', () => {
    if (!entered) $('#boot-text').textContent = "Can't reach the server. Retrying…";
  });

  socket.connect();
}

boot();
