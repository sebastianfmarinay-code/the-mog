'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Store, DAY_MS } = require('../src/store');

const AVATAR = { emoji: '🦊', color: '#ff6b4a' };

function clock(start = Date.parse('2026-11-20T12:00:00Z')) {
  let now = start;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
  };
}

function twoFriends(store) {
  const a = store.createUser({ username: 'alice', avatar: AVATAR }).user;
  const b = store.createUser({ username: 'bob', avatar: AVATAR }).user;
  store.addFriendship(a.id, b.id);
  return { a, b, f: store.friendship(a.id, b.id) };
}

test('usernames are validated, normalised and unique', () => {
  const store = new Store();
  assert.equal(store.createUser({ username: 'no', avatar: AVATAR }).error, 'invalid');
  assert.equal(store.createUser({ username: 'has space', avatar: AVATAR }).error, 'invalid');
  const { user, token } = store.createUser({ username: '@Cool_Cat.9', avatar: AVATAR });
  assert.equal(user.username, 'cool_cat.9');
  assert.equal(store.createUser({ username: 'COOL_cat.9', avatar: AVATAR }).error, 'taken');
  assert.equal(store.userByToken(token).id, user.id);
  assert.equal(store.userByToken('wrong'), null);
  assert.equal(store.userByUsername('@cool_CAT.9').id, user.id);
  assert.ok(!('token' in user), 'only a hash of the token is stored');
});

test('streaks need both people to snap each day and reset after a missed day', () => {
  const c = clock();
  const store = new Store({ now: c.now });
  const { a, b, f } = twoFriends(store);

  assert.deepEqual(store.recordSnap(a.id, b.id), { streak: 0, atRisk: false });
  assert.deepEqual(store.recordSnap(b.id, a.id), { streak: 1, atRisk: false });
  store.recordSnap(a.id, b.id); // more snaps the same day don't add more
  assert.equal(f.streak, 1);

  c.advance(DAY_MS);
  assert.deepEqual(store.streakInfo(f), { streak: 1, atRisk: true });
  store.recordSnap(a.id, b.id);
  assert.deepEqual(store.recordSnap(b.id, a.id), { streak: 2, atRisk: false });

  c.advance(2 * DAY_MS); // a whole day missed
  assert.deepEqual(store.streakInfo(f), { streak: 0, atRisk: false });
  store.recordSnap(a.id, b.id);
  assert.deepEqual(store.recordSnap(b.id, a.id), { streak: 1, atRisk: false });
});

test('mutual friend requests become a friendship', () => {
  const store = new Store();
  const a = store.createUser({ username: 'alice', avatar: AVATAR }).user;
  const b = store.createUser({ username: 'bob', avatar: AVATAR }).user;
  assert.equal(store.addRequest(a.id, b.id), 'sent');
  assert.equal(store.addRequest(a.id, b.id), 'exists');
  assert.equal(store.requestsFor(b.id).incoming.length, 1);
  assert.equal(store.addRequest(b.id, a.id), 'friends');
  assert.ok(store.areFriends(a.id, b.id));
  assert.equal(store.requestsFor(a.id).outgoing.length, 0);
  assert.deepEqual(store.friendIdsOf(a.id), [b.id]);
});

test('unfriending drops anything still waiting between them', () => {
  const store = new Store();
  const { a, b } = twoFriends(store);
  const snapId = crypto.randomUUID();
  store.saveMedia(snapId, Buffer.from('img'));
  store.addInboxItem(b.id, { id: snapId, type: 'snap', from: a.id, at: Date.now() });
  store.addInboxItem(b.id, { id: crypto.randomUUID(), type: 'message', from: a.id, at: Date.now(), text: 'hi' });
  store.removeFriendship(a.id, b.id);
  assert.deepEqual(store.inboxFor(b.id), []);
  assert.equal(store.loadMedia(snapId), null);
  assert.deepEqual(store.friendIdsOf(a.id), []);
});

test('stories expire after a day and prune deletes their images', () => {
  const c = clock();
  const store = new Store({ now: c.now });
  const { a, b } = twoFriends(store);
  const id = crypto.randomUUID();
  store.saveMedia(id, Buffer.from('img'));
  store.addStory(a.id, { id, mime: 'image/jpeg' });
  store.markStoryViewed(id, b.id);
  store.markStoryViewed(id, b.id);
  store.markStoryViewed(id, a.id); // owners don't count as viewers
  assert.deepEqual(store.story(id).views, [b.id]);

  c.advance(DAY_MS + 1);
  assert.equal(store.story(id), null);
  assert.deepEqual(store.storiesOf(a.id), []);
  store.prune();
  assert.equal(store.loadMedia(id), null);
});

test('saves to disk and loads back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mog-store-'));
  try {
    const store = new Store({ dir });
    const { a, b } = twoFriends(store);
    const { token } = store.createUser({ username: 'carol', avatar: AVATAR });
    const mediaId = crypto.randomUUID();
    store.saveMedia(mediaId, Buffer.from('picture'));
    store.flush();

    const reloaded = new Store({ dir });
    assert.ok(reloaded.areFriends(a.id, b.id));
    assert.equal(reloaded.userByToken(token).username, 'carol');
    assert.equal(reloaded.loadMedia(mediaId).toString(), 'picture');
    assert.equal(reloaded.loadMedia('../db.json'), null, 'media ids cannot escape the media folder');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
