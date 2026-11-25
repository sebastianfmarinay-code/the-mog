// Client-side copy of the social state: who I am, friends, requests and
// unopened messages/snaps. The server is the source of truth; `sync()` pulls
// a fresh snapshot and live events patch it in between.

import { socket, ask } from './net.js';
import { bus } from './ui.js';

export const social = {
  me: null,
  friends: [],
  requests: { incoming: [], outgoing: [] },
  inbox: [],

  friend(id) {
    return this.friends.find((f) => f.id === id) || null;
  },

  unread(friendId) {
    let snaps = 0;
    let messages = 0;
    let latest = 0;
    for (const item of this.inbox) {
      if (item.from !== friendId) continue;
      if (item.type === 'snap') snaps += 1;
      else messages += 1;
      latest = Math.max(latest, item.at);
    }
    return { snaps, messages, latest };
  },

  snapsFrom(friendId) {
    return this.inbox.filter((i) => i.from === friendId && i.type === 'snap').sort((a, b) => a.at - b.at);
  },

  messagesFrom(friendId) {
    return this.inbox.filter((i) => i.from === friendId && i.type === 'message').sort((a, b) => a.at - b.at);
  },

  removeInbox(ids) {
    const set = new Set(ids);
    this.inbox = this.inbox.filter((i) => !set.has(i.id));
    bus.emit('social');
  },

  async sync() {
    const res = await ask('sync');
    if (!res.ok) return false;
    this.me = res.user;
    this.friends = res.friends;
    this.requests = res.requests;
    this.inbox = res.inbox;
    bus.emit('social');
    return true;
  },
};

let syncTimer = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => social.sync(), 120);
}

socket.on('friends_changed', scheduleSync);

socket.on('inbox_item', (item) => {
  if (!social.inbox.some((i) => i.id === item.id)) social.inbox.push(item);
  bus.emit('social');
  bus.emit('inbox_item', item);
});

socket.on('presence', ({ id, online }) => {
  const friend = social.friend(id);
  if (!friend) return;
  friend.online = online;
  bus.emit('social');
});

socket.on('friend_request', ({ from }) => bus.emit('friend_request', from));
socket.on('friend_accepted', ({ by }) => bus.emit('friend_accepted', by));
socket.on('snap_opened', (data) => bus.emit('snap_opened', data));
socket.on('messages_seen', (data) => bus.emit('messages_seen', data));
socket.on('dm_typing', (data) => bus.emit('dm_typing', data));
socket.on('stories_changed', () => bus.emit('stories_changed'));
socket.on('story_viewed', (data) => bus.emit('story_viewed', data));
