'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[a-z0-9_.]{3,20}$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_INBOX_PER_USER = 500;

/** Calendar day in UTC, e.g. "2026-11-25". Streaks count these. */
function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function previousDay(key) {
  return dayKey(Date.parse(`${key}T00:00:00Z`) - DAY_MS);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function normalizeUsername(name) {
  if (typeof name !== 'string') return '';
  return name.trim().replace(/^@/, '').toLowerCase();
}

function isValidUsername(name) {
  return USERNAME_RE.test(name);
}

function isId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

/**
 * Everything the social side of the app remembers: accounts, friendships,
 * friend requests, undelivered messages/snaps ("inbox") and stories.
 *
 * Data lives in memory and, when `dir` is given, is saved to `dir/db.json`
 * (images go in `dir/media/`). Without `dir` nothing touches the disk, which
 * is what the tests use.
 */
class Store {
  constructor({ dir = null, now = Date.now, inboxTtlMs = 30 * DAY_MS, storyTtlMs = DAY_MS } = {}) {
    this.dir = dir;
    this.now = now;
    this.inboxTtlMs = inboxTtlMs;
    this.storyTtlMs = storyTtlMs;
    this.memoryMedia = new Map();
    this.saveTimer = null;
    this.data = { version: 1, users: {}, friendships: {}, requests: [], inbox: {}, stories: [] };

    if (dir) {
      fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
      const file = this._dbFile();
      if (fs.existsSync(file)) {
        const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.data = { ...this.data, ...loaded };
      }
    }
    this._reindex();
  }

  // ---------- persistence ----------

  _dbFile() {
    return path.join(this.dir, 'db.json');
  }

  _reindex() {
    this.byToken = new Map();
    this.byUsername = new Map();
    this.friendIndex = new Map();
    for (const user of Object.values(this.data.users)) {
      this.byToken.set(user.tokenHash, user.id);
      this.byUsername.set(user.username, user.id);
    }
    for (const f of Object.values(this.data.friendships)) this._indexFriend(f.a, f.b, true);
  }

  _indexFriend(a, b, add) {
    for (const [x, y] of [[a, b], [b, a]]) {
      let set = this.friendIndex.get(x);
      if (!set) {
        set = new Set();
        this.friendIndex.set(x, set);
      }
      if (add) set.add(y);
      else set.delete(y);
    }
  }

  _save() {
    if (!this.dir || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 200);
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
  }

  /** Write the database to disk right now (atomically, via a temp file). */
  flush() {
    if (!this.dir) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const file = this._dbFile();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, file);
  }

  // ---------- users ----------

  createUser({ username, avatar }) {
    const name = normalizeUsername(username);
    if (!isValidUsername(name)) return { error: 'invalid' };
    if (this.byUsername.has(name)) return { error: 'taken' };

    const token = crypto.randomBytes(32).toString('base64url');
    const user = {
      id: crypto.randomUUID(),
      username: name,
      avatar,
      createdAt: this.now(),
      tokenHash: hashToken(token),
    };
    this.data.users[user.id] = user;
    this.byToken.set(user.tokenHash, user.id);
    this.byUsername.set(name, user.id);
    this._save();
    return { user, token };
  }

  userByToken(token) {
    if (typeof token !== 'string' || !token || token.length > 200) return null;
    const id = this.byToken.get(hashToken(token));
    return id ? this.data.users[id] : null;
  }

  userById(id) {
    return (typeof id === 'string' && this.data.users[id]) || null;
  }

  userByUsername(username) {
    const id = this.byUsername.get(normalizeUsername(username));
    return id ? this.data.users[id] : null;
  }

  isUsernameAvailable(username) {
    const name = normalizeUsername(username);
    return isValidUsername(name) && !this.byUsername.has(name);
  }

  updateAvatar(id, avatar) {
    const user = this.userById(id);
    if (!user) return null;
    user.avatar = avatar;
    this._save();
    return user;
  }

  // ---------- friends ----------

  friendship(a, b) {
    return this.data.friendships[pairKey(a, b)] || null;
  }

  areFriends(a, b) {
    return Boolean(this.friendship(a, b));
  }

  friendIdsOf(id) {
    return [...(this.friendIndex.get(id) || [])];
  }

  addFriendship(a, b) {
    if (a === b || !this.userById(a) || !this.userById(b)) return null;
    const key = pairKey(a, b);
    let f = this.data.friendships[key];
    if (!f) {
      const [x, y] = a < b ? [a, b] : [b, a];
      f = { a: x, b: y, since: this.now(), streak: 0, streakDay: null, day: null, sentA: false, sentB: false };
      this.data.friendships[key] = f;
      this._indexFriend(a, b, true);
    }
    this.data.requests = this.data.requests.filter(
      (r) => !((r.from === a && r.to === b) || (r.from === b && r.to === a)),
    );
    this._save();
    return f;
  }

  removeFriendship(a, b) {
    const key = pairKey(a, b);
    if (!this.data.friendships[key]) return false;
    delete this.data.friendships[key];
    this._indexFriend(a, b, false);
    // Anything still waiting between them is dropped.
    for (const [to, from] of [[a, b], [b, a]]) {
      const box = this.data.inbox[to];
      if (!box) continue;
      this.data.inbox[to] = box.filter((item) => {
        if (item.from !== from) return true;
        if (item.type === 'snap') this.deleteMedia(item.id);
        return false;
      });
    }
    this._save();
    return true;
  }

  /** Current streak as people see it, accounting for days that were missed. */
  streakInfo(f) {
    if (!f || !f.streakDay) return { streak: 0, atRisk: false };
    const today = dayKey(this.now());
    if (f.streakDay === today) return { streak: f.streak, atRisk: false };
    if (f.streakDay === previousDay(today)) return { streak: f.streak, atRisk: true };
    return { streak: 0, atRisk: false };
  }

  /**
   * A snap went from `from` to `to`. A streak day counts once both of them
   * have sent the other a snap on the same (UTC) day; consecutive days build
   * the streak, a missed day resets it.
   */
  recordSnap(from, to) {
    const f = this.friendship(from, to);
    if (!f) return null;
    const today = dayKey(this.now());
    if (f.day !== today) {
      f.day = today;
      f.sentA = false;
      f.sentB = false;
    }
    if (from === f.a) f.sentA = true;
    else f.sentB = true;

    if (f.sentA && f.sentB && f.streakDay !== today) {
      f.streak = f.streakDay === previousDay(today) ? f.streak + 1 : 1;
      f.streakDay = today;
    }
    this._save();
    return this.streakInfo(f);
  }

  // ---------- friend requests ----------

  /** Returns 'sent', 'exists', or 'friends' (they had already asked you). */
  addRequest(from, to) {
    if (this.data.requests.some((r) => r.from === from && r.to === to)) return 'exists';
    if (this.data.requests.some((r) => r.from === to && r.to === from)) {
      this.addFriendship(from, to);
      return 'friends';
    }
    this.data.requests.push({ from, to, at: this.now() });
    this._save();
    return 'sent';
  }

  hasRequest(from, to) {
    return this.data.requests.some((r) => r.from === from && r.to === to);
  }

  removeRequest(from, to) {
    const before = this.data.requests.length;
    this.data.requests = this.data.requests.filter((r) => !(r.from === from && r.to === to));
    if (this.data.requests.length !== before) {
      this._save();
      return true;
    }
    return false;
  }

  requestsFor(id) {
    return {
      incoming: this.data.requests.filter((r) => r.to === id),
      outgoing: this.data.requests.filter((r) => r.from === id),
    };
  }

  // ---------- inbox (undelivered / unopened messages and snaps) ----------

  addInboxItem(to, item) {
    const box = this.data.inbox[to] || (this.data.inbox[to] = []);
    box.push(item);
    while (box.length > MAX_INBOX_PER_USER) {
      const dropped = box.shift();
      if (dropped.type === 'snap') this.deleteMedia(dropped.id);
    }
    this._save();
    return item;
  }

  inboxFor(id) {
    return [...(this.data.inbox[id] || [])];
  }

  /** Remove and return one item from someone's inbox. */
  takeInboxItem(to, itemId) {
    const box = this.data.inbox[to];
    if (!box) return null;
    const index = box.findIndex((item) => item.id === itemId);
    if (index === -1) return null;
    const [item] = box.splice(index, 1);
    this._save();
    return item;
  }

  /** Mark all text messages from `from` as read (which deletes them). */
  removeMessagesFrom(to, from) {
    const box = this.data.inbox[to];
    if (!box) return [];
    const removed = [];
    this.data.inbox[to] = box.filter((item) => {
      if (item.type === 'message' && item.from === from) {
        removed.push(item.id);
        return false;
      }
      return true;
    });
    if (removed.length) this._save();
    return removed;
  }

  // ---------- media ----------

  saveMedia(id, buffer) {
    if (!isId(id)) throw new Error('Bad media id');
    if (this.dir) fs.writeFileSync(path.join(this.dir, 'media', id), buffer);
    else this.memoryMedia.set(id, Buffer.from(buffer));
  }

  loadMedia(id) {
    if (!isId(id)) return null;
    if (!this.dir) return this.memoryMedia.get(id) || null;
    try {
      return fs.readFileSync(path.join(this.dir, 'media', id));
    } catch {
      return null;
    }
  }

  deleteMedia(id) {
    if (!isId(id)) return;
    if (!this.dir) {
      this.memoryMedia.delete(id);
      return;
    }
    fs.rm(path.join(this.dir, 'media', id), { force: true }, () => {});
  }

  // ---------- stories ----------

  addStory(userId, { id, mime }) {
    const at = this.now();
    const story = { id, userId, mime, at, expiresAt: at + this.storyTtlMs, views: [] };
    this.data.stories.push(story);
    this._save();
    return story;
  }

  story(id) {
    const story = this.data.stories.find((s) => s.id === id);
    return story && story.expiresAt > this.now() ? story : null;
  }

  storiesOf(userId) {
    const now = this.now();
    return this.data.stories.filter((s) => s.userId === userId && s.expiresAt > now);
  }

  markStoryViewed(storyId, viewerId) {
    const story = this.story(storyId);
    if (!story || story.userId === viewerId || story.views.includes(viewerId)) return;
    story.views.push(viewerId);
    this._save();
  }

  deleteStory(id) {
    const index = this.data.stories.findIndex((s) => s.id === id);
    if (index === -1) return false;
    const [story] = this.data.stories.splice(index, 1);
    this.deleteMedia(story.id);
    this._save();
    return true;
  }

  /** Drop expired stories and stale inbox items. Call periodically. */
  prune() {
    const now = this.now();
    let changed = false;
    this.data.stories = this.data.stories.filter((s) => {
      if (s.expiresAt > now) return true;
      this.deleteMedia(s.id);
      changed = true;
      return false;
    });
    for (const [userId, box] of Object.entries(this.data.inbox)) {
      const kept = box.filter((item) => {
        if (now - item.at < this.inboxTtlMs) return true;
        if (item.type === 'snap') this.deleteMedia(item.id);
        changed = true;
        return false;
      });
      if (kept.length) this.data.inbox[userId] = kept;
      else delete this.data.inbox[userId];
    }
    if (changed) this._save();
  }
}

module.exports = { Store, dayKey, previousDay, normalizeUsername, isValidUsername, isId, DAY_MS };
