'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, once, never, ask, pair, friends, AVATAR } = require('./helpers');
const { detectImageType } = require('../src/media');

// Smallest valid-looking JPEG header plus some bytes.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);

test('detectImageType checks magic bytes and size', () => {
  assert.equal(detectImageType(JPEG), 'image/jpeg');
  assert.equal(detectImageType(Buffer.from('RIFF0000WEBPVP8 ')), 'image/webp');
  assert.equal(detectImageType(Buffer.from('<svg onload=alert(1)>')), null);
  assert.equal(detectImageType(Buffer.alloc(2 * 1024 * 1024, 0xff)), null);
});

test('register, then sign back in with the token', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.stop());

  const anon = await ctx.client({ register: false });
  assert.deepEqual(await ask(anon, 'check_username', { username: 'Night_Owl' }), { ok: true, valid: true, available: true });
  assert.equal((await ask(anon, 'register', { username: 'night_owl', avatar: { emoji: '💩', color: '#000' } })).error, 'invalid_avatar');
  const res = await ask(anon, 'register', { username: 'Night_Owl', avatar: AVATAR });
  assert.equal(res.ok, true);
  assert.equal(res.user.username, 'night_owl');
  assert.equal((await ask(anon, 'check_username', { username: 'night_owl' })).available, false);

  const other = await ctx.client({ register: false });
  assert.equal((await ask(other, 'register', { username: 'NIGHT_OWL', avatar: AVATAR })).error, 'taken');
  assert.equal((await ask(other, 'sync')).error, 'auth');

  const again = await ctx.client({ token: res.token });
  assert.equal(again.session.user.username, 'night_owl');
  const sync = await ask(again, 'sync');
  assert.deepEqual(sync.friends, []);
});

test('friend requests by username, presence and removal', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.stop());
  const a = await ctx.client();
  const b = await ctx.client();

  assert.equal((await ask(a, 'friend_request', { username: 'nobody_here' })).error, 'not_found');
  assert.equal((await ask(a, 'friend_request', { username: a.user.username })).error, 'self');

  const incoming = once(b, 'friend_request');
  assert.equal((await ask(a, 'friend_request', { username: `@${b.user.username.toUpperCase()}` })).status, 'sent');
  assert.equal((await incoming).from.username, a.user.username);
  assert.equal((await ask(b, 'sync')).requests.incoming[0].id, a.user.id);

  const accepted = once(a, 'friend_accepted');
  await ask(b, 'respond_request', { from: a.user.id, accept: true });
  assert.equal((await accepted).by.id, b.user.id);

  const friendsOfA = (await ask(a, 'sync')).friends;
  assert.equal(friendsOfA.length, 1);
  assert.equal(friendsOfA[0].username, b.user.username);
  assert.equal(friendsOfA[0].online, true);
  assert.equal(friendsOfA[0].streak, 0);

  const offline = once(a, 'presence');
  b.disconnect();
  assert.deepEqual(await offline, { id: b.user.id, online: false });

  const changed = once(a, 'friends_changed');
  assert.equal((await ask(a, 'remove_friend', { id: b.user.id })).ok, true);
  await changed;
  assert.deepEqual((await ask(a, 'sync')).friends, []);
});

test('friend messages are delivered live, kept until read, then deleted', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.stop());
  const { a, b } = await friends(ctx);

  const live = once(b, 'inbox_item');
  const sent = await ask(a, 'dm', { to: b.user.id, text: '  hey you  ' });
  assert.equal(sent.ok, true);
  const item = await live;
  assert.equal(item.text, 'hey you');
  assert.equal(item.from, a.user.id);

  // Still there after reconnecting, because it hasn't been read.
  b.disconnect();
  const b2 = await ctx.client({ token: b.token });
  assert.equal((await ask(b2, 'sync')).inbox.length, 1);

  const seen = once(a, 'messages_seen');
  assert.deepEqual((await ask(b2, 'read_messages', { from: a.user.id })).ids, [sent.id]);
  assert.deepEqual((await seen).ids, [sent.id]);
  assert.deepEqual((await ask(b2, 'sync')).inbox, []);

  const stranger = await ctx.client();
  assert.equal((await ask(stranger, 'dm', { to: a.user.id, text: 'hi' })).error, 'not_friends');
});

test('friend snaps open exactly once and build streaks', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.stop());
  const { a, b } = await friends(ctx);

  assert.equal((await ask(a, 'snap', { image: Buffer.from('not an image'), to: [b.user.id] })).error, 'invalid_image');
  assert.equal((await ask(a, 'snap', { image: JPEG, to: [] })).error, 'no_recipients');

  const arrived = once(b, 'inbox_item');
  const sent = await ask(a, 'snap', { image: JPEG, duration: 99, to: [b.user.id, 'not-a-friend'] });
  assert.equal(sent.ok, true);
  assert.equal(sent.sent.length, 1);
  const item = await arrived;
  assert.deepEqual(Object.keys(item).sort(), ['at', 'duration', 'from', 'id', 'type']);
  assert.equal(item.duration, 10, 'duration is capped at 10 seconds');

  const opened = once(a, 'snap_opened');
  const view = await ask(b, 'open_snap', { id: item.id });
  assert.equal(view.ok, true);
  assert.equal(view.mime, 'image/jpeg');
  assert.ok(Buffer.from(view.image).equals(JPEG));
  assert.deepEqual(await opened, { id: item.id, by: b.user.id });
  assert.equal((await ask(b, 'open_snap', { id: item.id })).error, 'gone', 'a snap can only be opened once');

  await ask(b, 'snap', { image: JPEG, to: [a.user.id] });
  const [friend] = (await ask(a, 'sync')).friends;
  assert.equal(friend.streak, 1);
});

test('stories are visible to friends only and record viewers', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.stop());
  const { a, b } = await friends(ctx);
  const outsider = await ctx.client();

  const changed = once(b, 'stories_changed');
  const posted = await ask(a, 'snap', { image: JPEG, story: true });
  assert.ok(posted.story);
  await changed;

  const feed = await ask(b, 'stories');
  assert.equal(feed.friends.length, 1);
  assert.equal(feed.friends[0].user.id, a.user.id);
  assert.equal(feed.friends[0].stories[0].viewed, false);

  assert.equal((await ask(outsider, 'view_story', { id: posted.story })).error, 'not_found');

  const viewed = once(a, 'story_viewed');
  const story = await ask(b, 'view_story', { id: posted.story });
  assert.equal(story.ok, true);
  assert.equal((await viewed).by.id, b.user.id);
  assert.equal((await ask(b, 'stories')).friends[0].stories[0].viewed, true);
  assert.deepEqual((await ask(a, 'stories')).mine[0].views.map((v) => v.id), [b.user.id]);

  assert.equal((await ask(b, 'delete_story', { id: posted.story })).error, 'not_found');
  assert.equal((await ask(a, 'delete_story', { id: posted.story })).ok, true);
  assert.deepEqual((await ask(b, 'stories')).friends, []);
});

test('strangers can swap snaps during a random chat', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.stop());
  const { a, b } = await pair(ctx);

  const received = once(b, 'snap_received');
  const sent = await ask(a, 'snap', { image: JPEG, duration: 3, stranger: true });
  const { id, duration } = await received;
  assert.equal(id, sent.stranger);
  assert.equal(duration, 3);

  const opened = once(a, 'snap_opened');
  const view = await ask(b, 'open_snap', { id });
  assert.ok(Buffer.from(view.image).equals(JPEG));
  assert.deepEqual(await opened, { id });

  // Unopened snaps vanish when the chat ends.
  const second = once(b, 'snap_received');
  await ask(a, 'snap', { image: JPEG, stranger: true });
  const { id: unopened } = await second;
  a.emit('leave');
  await once(b, 'partner_left');
  assert.equal((await ask(b, 'open_snap', { id: unopened })).error, 'gone');
});

test('both strangers pressing "add friend" makes them friends', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.stop());
  const { a, b } = await pair(ctx);

  const asked = once(b, 'stranger_wants_add');
  assert.equal((await ask(a, 'stranger_add')).status, 'waiting');
  await asked;
  await never(a, 'stranger_friended', 50);

  const aFriended = once(a, 'stranger_friended');
  const bFriended = once(b, 'stranger_friended');
  assert.equal((await ask(b, 'stranger_add')).status, 'friends');
  assert.equal((await aFriended).friend.username, b.user.username);
  assert.equal((await bFriended).friend.username, a.user.username);
  assert.equal((await ask(a, 'sync')).friends[0].id, b.user.id);
});

test('a pending "add friend" is forgotten when the chat ends', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.stop());
  const { a, b } = await pair(ctx);
  await ask(a, 'stranger_add');

  // Skip and get rematched with the same person (they're the only two online).
  const matched = Promise.all([once(a, 'matched'), once(b, 'matched')]);
  a.emit('find', { mode: 'text' });
  await once(b, 'partner_left');
  b.emit('find', { mode: 'text' });
  await matched;

  assert.equal((await ask(b, 'stranger_add')).status, 'waiting');
});
