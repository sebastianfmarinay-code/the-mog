// Stories: friends' snaps that last 24 hours, and your own story.

import { ask } from './net.js';
import { $, h, avatar, paintAvatar, bus, timeAgo, plural } from './ui.js';
import { social } from './social.js';
import { snapTo, currentTab } from './nav.js';
import { viewStories } from './viewer.js';

const els = {};
export const storyFeed = { mine: [], friends: [], loaded: false };

export async function loadStories() {
  const res = await ask('stories');
  if (!res.ok) return;
  storyFeed.mine = res.mine;
  storyFeed.friends = res.friends;
  storyFeed.loaded = true;
  render();
  bus.emit('stories_loaded');
}

function hasUnseen(entry) {
  return entry.stories.some((s) => !s.viewed);
}

export function playMyStory({ onClose } = {}) {
  if (!storyFeed.mine.length) return;
  const viewers = Object.fromEntries(storyFeed.mine.map((s) => [s.id, s.views]));
  viewStories(
    storyFeed.mine.map((s) => ({ id: s.id, at: s.at, user: social.me })),
    {
      own: true,
      viewers,
      onDelete: () => loadStories(),
      onClose: () => {
        loadStories();
        onClose?.();
      },
    },
  );
}

function playFriend(entry) {
  const items = entry.stories.map((s) => ({ id: s.id, at: s.at, user: entry.user }));
  const firstUnseen = entry.stories.findIndex((s) => !s.viewed);
  viewStories(items, { index: firstUnseen === -1 ? 0 : firstUnseen, onClose: loadStories });
}

function render() {
  if (social.me) paintAvatar(els.myAvatar, social.me);
  const mine = storyFeed.mine;
  els.myAvatar.classList.toggle('has-story', mine.length > 0);
  if (mine.length) {
    const viewers = new Set(mine.flatMap((s) => s.views.map((v) => v.id)));
    els.mySub.textContent = `${plural(mine.length, 'snap')} · ${plural(viewers.size, 'viewer')} · tap to watch`;
  } else {
    els.mySub.textContent = 'Tap to add a snap · visible to friends for 24h';
  }

  const friends = [...storyFeed.friends].sort((a, b) => Number(hasUnseen(b)) - Number(hasUnseen(a)) || b.latest - a.latest);
  els.empty.hidden = friends.length > 0;
  els.list.replaceChildren(
    ...friends.map((entry) => {
      const pic = avatar(entry.user, 'lg');
      pic.classList.add(hasUnseen(entry) ? 'ring-new' : 'ring-seen');
      const btn = h(
        'button',
        { class: 'story-card', type: 'button' },
        pic,
        h('strong', { class: 'story-card__name', text: entry.user.username }),
        h('span', { class: 'story-card__time', text: timeAgo(entry.latest) }),
      );
      btn.addEventListener('click', () => playFriend(entry));
      return h('li', {}, btn);
    }),
  );
  bus.emit('badge', { tab: 'stories', on: friends.some(hasUnseen) });
}

export function initStories() {
  Object.assign(els, {
    my: $('#my-story'),
    myAdd: $('#my-story-add'),
    myAvatar: $('#my-story-avatar'),
    mySub: $('#my-story-sub'),
    list: $('#story-list'),
    empty: $('#stories-empty'),
  });
  els.my.addEventListener('click', () => {
    if (storyFeed.mine.length) playMyStory();
    else snapTo({ type: 'story' }, 'stories');
  });
  els.myAdd.addEventListener('click', () => snapTo({ type: 'story' }, 'stories'));
  bus.on('stories_changed', loadStories);
  bus.on('snap_sent', (res) => res.story && loadStories());
  bus.on('story_viewed', () => currentTab() === 'stories' && loadStories());
  bus.on('social', render);
}
