'use strict';

const crypto = require('crypto');
const { isValidAvatar } = require('./avatars');
const { detectImageType, toBuffer } = require('./media');
const { isValidUsername, normalizeUsername } = require('./store');

const MAX_SNAP_TARGETS = 100;

function publicUser(user) {
  return user ? { id: user.id, username: user.username, avatar: user.avatar } : null;
}

function inboxView(item) {
  const { id, type, from, at } = item;
  return type === 'message' ? { id, type, from, at, text: item.text } : { id, type, from, at, duration: item.duration };
}

/**
 * Accounts, friends, friend chat, snaps and stories.
 *
 * `getPartner(socket)` comes from the random-chat side so snaps and
 * "add friend" can reach the stranger someone is currently talking to.
 */
function createSocial({ io, store, log, getPartner, allow, cleanMessage, maxMessageLength }) {
  const onlineCount = new Map(); // userId -> number of connected sockets
  const strangerSnaps = new Map(); // snapId -> { buffer, mime, from, to, duration }

  const room = (userId) => `u:${userId}`;
  const emitToUser = (userId, event, data) => io.to(room(userId)).emit(event, data);
  const isOnline = (userId) => (onlineCount.get(userId) || 0) > 0;
  const friendsChanged = (...userIds) => userIds.forEach((id) => emitToUser(id, 'friends_changed'));

  function attachUser(socket, user) {
    socket.data.user = user;
    socket.join(room(user.id));
    const count = (onlineCount.get(user.id) || 0) + 1;
    onlineCount.set(user.id, count);
    if (count === 1) {
      for (const id of store.friendIdsOf(user.id)) emitToUser(id, 'presence', { id: user.id, online: true });
    }
  }

  function detachUser(socket) {
    const user = socket.data.user;
    if (!user) return;
    const count = (onlineCount.get(user.id) || 1) - 1;
    if (count > 0) {
      onlineCount.set(user.id, count);
      return;
    }
    onlineCount.delete(user.id);
    for (const id of store.friendIdsOf(user.id)) emitToUser(id, 'presence', { id: user.id, online: false });
  }

  function friendView(meId, friendId) {
    const f = store.friendship(meId, friendId);
    return {
      ...publicUser(store.userById(friendId)),
      online: isOnline(friendId),
      since: f.since,
      ...store.streakInfo(f),
    };
  }

  function snapshot(userId) {
    const requests = store.requestsFor(userId);
    const people = (list, key) =>
      list
        .map((r) => ({ ...publicUser(store.userById(r[key])), at: r.at }))
        .filter((r) => r.id);
    return {
      user: publicUser(store.userById(userId)),
      friends: store.friendIdsOf(userId).map((id) => friendView(userId, id)),
      requests: { incoming: people(requests.incoming, 'from'), outgoing: people(requests.outgoing, 'to') },
      inbox: store.inboxFor(userId).map(inboxView),
    };
  }

  /** Forget unopened snaps between strangers once their chat ends. */
  function dropStrangerSnaps(socketId) {
    for (const [id, snap] of strangerSnaps) {
      if (snap.from === socketId || snap.to === socketId) strangerSnaps.delete(id);
    }
  }

  function storiesFeed(meId) {
    const mine = store.storiesOf(meId).map((s) => ({
      id: s.id,
      at: s.at,
      expiresAt: s.expiresAt,
      views: s.views.map((id) => publicUser(store.userById(id))).filter(Boolean),
    }));
    const friends = store
      .friendIdsOf(meId)
      .map((id) => {
        const list = store.storiesOf(id);
        if (!list.length) return null;
        return {
          user: publicUser(store.userById(id)),
          latest: list[list.length - 1].at,
          stories: list.map((s) => ({ id: s.id, at: s.at, viewed: s.views.includes(meId) })),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.latest - a.latest);
    return { mine, friends };
  }

  function register(socket) {
    /** Wrap a handler: normalise payload/ack, enforce sign-in, catch errors. */
    const on = (event, handler, { auth = true } = {}) => {
      socket.on(event, (payload, ack) => {
        let reply = typeof ack === 'function' ? ack : () => {};
        if (typeof payload === 'function') {
          reply = payload;
          payload = undefined;
        }
        if (auth && !socket.data.user) return reply({ ok: false, error: 'auth' });
        try {
          handler(payload && typeof payload === 'object' ? payload : {}, reply);
        } catch (err) {
          log.error?.(`[${event}]`, err);
          reply({ ok: false, error: 'server' });
        }
      });
    };
    const me = () => socket.data.user;

    // ----- account -----

    on(
      'check_username',
      ({ username }, reply) => {
        const name = normalizeUsername(username);
        reply({ ok: true, valid: isValidUsername(name), available: store.isUsernameAvailable(name) });
      },
      { auth: false },
    );

    on(
      'register',
      ({ username, avatar }, reply) => {
        if (socket.data.user) return reply({ ok: false, error: 'already_registered' });
        if (!allow(socket, 'register', 5, 60_000)) return reply({ ok: false, error: 'rate_limited' });
        if (!isValidAvatar(avatar)) return reply({ ok: false, error: 'invalid_avatar' });
        const result = store.createUser({ username, avatar: { emoji: avatar.emoji, color: avatar.color } });
        if (result.error) return reply({ ok: false, error: result.error });
        attachUser(socket, result.user);
        reply({ ok: true, token: result.token, user: publicUser(result.user) });
      },
      { auth: false },
    );

    on('sync', (_, reply) => reply({ ok: true, ...snapshot(me().id) }));

    on('update_profile', ({ avatar }, reply) => {
      if (!isValidAvatar(avatar)) return reply({ ok: false, error: 'invalid_avatar' });
      const user = store.updateAvatar(me().id, { emoji: avatar.emoji, color: avatar.color });
      friendsChanged(...store.friendIdsOf(user.id));
      reply({ ok: true, user: publicUser(user) });
    });

    // ----- friends -----

    on('friend_request', ({ username }, reply) => {
      if (!allow(socket, 'friend_request', 10, 60_000)) return reply({ ok: false, error: 'rate_limited' });
      const target = store.userByUsername(username);
      if (!target) return reply({ ok: false, error: 'not_found' });
      if (target.id === me().id) return reply({ ok: false, error: 'self' });
      if (store.areFriends(me().id, target.id)) return reply({ ok: false, error: 'already_friends' });

      const status = store.addRequest(me().id, target.id);
      if (status === 'sent') emitToUser(target.id, 'friend_request', { from: publicUser(me()) });
      if (status === 'friends') emitToUser(target.id, 'friend_accepted', { by: publicUser(me()) });
      friendsChanged(me().id, target.id);
      reply({ ok: true, status, user: publicUser(target) });
    });

    on('respond_request', ({ from, accept }, reply) => {
      if (!store.hasRequest(from, me().id)) return reply({ ok: false, error: 'not_found' });
      store.removeRequest(from, me().id);
      if (accept) {
        store.addFriendship(from, me().id);
        emitToUser(from, 'friend_accepted', { by: publicUser(me()) });
      }
      friendsChanged(from, me().id);
      reply({ ok: true });
    });

    on('cancel_request', ({ to }, reply) => {
      if (store.removeRequest(me().id, to)) friendsChanged(me().id, to);
      reply({ ok: true });
    });

    on('remove_friend', ({ id }, reply) => {
      if (!store.removeFriendship(me().id, id)) return reply({ ok: false, error: 'not_friends' });
      friendsChanged(me().id, id);
      reply({ ok: true });
    });

    // ----- friend chat -----

    on('dm', ({ to, text }, reply) => {
      if (!store.areFriends(me().id, to)) return reply({ ok: false, error: 'not_friends' });
      if (!allow(socket, 'dm', 15, 10_000)) return reply({ ok: false, error: 'rate_limited' });
      const clean = cleanMessage(text, maxMessageLength);
      if (!clean) return reply({ ok: false, error: 'empty' });
      const item = { id: crypto.randomUUID(), type: 'message', from: me().id, at: Date.now(), text: clean };
      store.addInboxItem(to, item);
      emitToUser(to, 'dm_typing', { from: me().id, typing: false });
      emitToUser(to, 'inbox_item', inboxView(item));
      reply({ ok: true, id: item.id, at: item.at, text: clean });
    });

    on('read_messages', ({ from }, reply) => {
      const ids = store.removeMessagesFrom(me().id, from);
      if (ids.length) emitToUser(from, 'messages_seen', { by: me().id, ids });
      reply({ ok: true, ids });
    });

    on('dm_typing', ({ to, typing }) => {
      if (store.areFriends(me().id, to)) emitToUser(to, 'dm_typing', { from: me().id, typing: Boolean(typing) });
    });

    // ----- snaps -----

    on('snap', (payload, reply) => {
      if (!allow(socket, 'snap', 20, 60_000)) return reply({ ok: false, error: 'rate_limited' });
      const buffer = toBuffer(payload.image);
      const mime = buffer && detectImageType(buffer);
      if (!mime) return reply({ ok: false, error: 'invalid_image' });

      const duration = Math.min(10, Math.max(1, Math.round(Number(payload.duration) || 5)));
      const friendIds = [...new Set(Array.isArray(payload.to) ? payload.to : [])]
        .filter((id) => typeof id === 'string' && store.areFriends(me().id, id))
        .slice(0, MAX_SNAP_TARGETS);
      const partner = payload.stranger ? getPartner(socket) : null;
      if (!friendIds.length && !partner && !payload.story) return reply({ ok: false, error: 'no_recipients' });

      const now = Date.now();
      const sent = friendIds.map((to) => {
        const item = { id: crypto.randomUUID(), type: 'snap', from: me().id, at: now, duration, mime };
        store.saveMedia(item.id, buffer);
        store.addInboxItem(to, item);
        store.recordSnap(me().id, to);
        emitToUser(to, 'inbox_item', inboxView(item));
        return { to, id: item.id };
      });
      if (sent.length) friendsChanged(me().id, ...friendIds);

      let strangerId = null;
      if (partner) {
        strangerId = crypto.randomUUID();
        strangerSnaps.set(strangerId, { buffer, mime, from: socket.id, to: partner.id, duration });
        partner.emit('snap_received', { id: strangerId, duration });
      }

      let storyId = null;
      if (payload.story) {
        storyId = crypto.randomUUID();
        store.saveMedia(storyId, buffer);
        store.addStory(me().id, { id: storyId, mime });
        for (const id of store.friendIdsOf(me().id)) emitToUser(id, 'stories_changed');
      }

      reply({ ok: true, sent, stranger: strangerId, story: storyId });
    });

    /** Opening a snap hands over the image once and deletes it for good. */
    on('open_snap', ({ id }, reply) => {
      const strangerSnap = strangerSnaps.get(id);
      if (strangerSnap && strangerSnap.to === socket.id) {
        strangerSnaps.delete(id);
        io.to(strangerSnap.from).emit('snap_opened', { id });
        return reply({ ok: true, image: strangerSnap.buffer, mime: strangerSnap.mime, duration: strangerSnap.duration });
      }

      const pending = store.inboxFor(me().id).find((item) => item.id === id && item.type === 'snap');
      if (!pending) return reply({ ok: false, error: 'gone' });
      store.takeInboxItem(me().id, id);
      const image = store.loadMedia(id);
      store.deleteMedia(id);
      emitToUser(pending.from, 'snap_opened', { id, by: me().id });
      if (!image) return reply({ ok: false, error: 'gone' });
      reply({ ok: true, image, mime: pending.mime, duration: pending.duration, from: pending.from });
    });

    // ----- stories -----

    on('stories', (_, reply) => reply({ ok: true, ...storiesFeed(me().id) }));

    on('view_story', ({ id }, reply) => {
      const story = store.story(id);
      if (!story || (story.userId !== me().id && !store.areFriends(me().id, story.userId))) {
        return reply({ ok: false, error: 'not_found' });
      }
      const image = store.loadMedia(story.id);
      if (!image) return reply({ ok: false, error: 'not_found' });
      if (story.userId !== me().id && !story.views.includes(me().id)) {
        store.markStoryViewed(story.id, me().id);
        emitToUser(story.userId, 'story_viewed', { id: story.id, by: publicUser(me()) });
      }
      reply({ ok: true, image, mime: story.mime, at: story.at, user: publicUser(store.userById(story.userId)) });
    });

    on('delete_story', ({ id }, reply) => {
      const story = store.story(id);
      if (!story || story.userId !== me().id) return reply({ ok: false, error: 'not_found' });
      store.deleteStory(id);
      for (const friendId of store.friendIdsOf(me().id)) emitToUser(friendId, 'stories_changed');
      reply({ ok: true });
    });

    // ----- befriending the stranger you're chatting with -----

    on('stranger_add', (_, reply) => {
      const partner = getPartner(socket);
      if (!partner) return reply({ ok: false, error: 'not_connected' });
      const other = partner.data.user;
      if (!other) return reply({ ok: false, error: 'not_connected' });
      if (other.id === me().id) return reply({ ok: false, error: 'self' });

      socket.data.wantsAdd = partner.id;
      const mutual = partner.data.wantsAdd === socket.id || store.areFriends(me().id, other.id);
      if (!mutual) {
        partner.emit('stranger_wants_add');
        return reply({ ok: true, status: 'waiting' });
      }
      store.addFriendship(me().id, other.id);
      socket.emit('stranger_friended', { friend: publicUser(other) });
      partner.emit('stranger_friended', { friend: publicUser(me()) });
      friendsChanged(me().id, other.id);
      reply({ ok: true, status: 'friends' });
    });
  }

  return { attachUser, detachUser, register, dropStrangerSnaps, publicUser, isOnline };
}

module.exports = { createSocial, publicUser };
