'use strict';

const MAX_INTERESTS = 10;
const MAX_INTEREST_LENGTH = 32;
const MODES = new Set(['text', 'video']);

/**
 * Clean up a user-supplied interest list: lowercase, collapse whitespace,
 * strip control characters, dedupe and cap both count and length.
 */
function normalizeInterests(list) {
  if (!Array.isArray(list)) return [];
  const out = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const tag = raw
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .slice(0, MAX_INTEREST_LENGTH)
      .trim();
    if (tag) out.add(tag);
    if (out.size >= MAX_INTERESTS) break;
  }
  return [...out];
}

/**
 * Queues people per chat mode and pairs them up.
 *
 * Pairing rules:
 *  - People are only paired with someone in the same mode (text / video).
 *  - Someone who listed interests is paired with the waiting person who shares
 *    the most of them (oldest first on ties).
 *  - If nobody shares an interest, they wait. After `fallbackMs` they become
 *    "random OK" (unless they opted out of the fallback) and can be paired
 *    with anyone else who is also random OK.
 *  - People with no interests are random OK from the start.
 */
class Matchmaker {
  constructor({
    fallbackMs = 8000,
    onMatch = () => {},
    canPair = () => true,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.fallbackMs = fallbackMs;
    this.onMatch = onMatch;
    this.canPair = canPair;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.queues = new Map([...MODES].map((m) => [m, new Map()]));
    this.entries = new Map();
  }

  /**
   * Add someone to the queue. Pairs them immediately if possible.
   * Returns the match `{ partnerId, common }` or null if they are waiting.
   */
  enqueue(id, { mode = 'text', interests = [], randomFallback = true } = {}) {
    if (!MODES.has(mode)) throw new Error(`Unknown mode: ${mode}`);
    this.dequeue(id);

    const tags = normalizeInterests(interests);
    const entry = {
      id,
      mode,
      interests: new Set(tags),
      randomOk: tags.length === 0,
      randomFallback: randomFallback !== false,
      since: Date.now(),
      timer: null,
    };

    const match = this._tryPair(entry);
    if (match) return match;

    this.queues.get(mode).set(id, entry);
    this.entries.set(id, entry);

    if (!entry.randomOk && entry.randomFallback) {
      entry.timer = this.setTimer(() => {
        entry.timer = null;
        if (this.entries.get(id) !== entry) return;
        entry.randomOk = true;
        this.queues.get(mode).delete(id);
        this.entries.delete(id);
        if (!this._tryPair(entry)) {
          this.queues.get(mode).set(id, entry);
          this.entries.set(id, entry);
        }
      }, this.fallbackMs);
      if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
    }
    return null;
  }

  /** Remove someone from the queue. Returns true if they were waiting. */
  dequeue(id) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.timer) this.clearTimer(entry.timer);
    this.queues.get(entry.mode).delete(id);
    this.entries.delete(id);
    return true;
  }

  isWaiting(id) {
    return this.entries.has(id);
  }

  waitingCount(mode) {
    if (mode) return this.queues.get(mode)?.size ?? 0;
    return this.entries.size;
  }

  _tryPair(entry) {
    const found = this._findPartner(entry);
    if (!found) return null;
    const { partner, common } = found;
    this.dequeue(partner.id);
    this.onMatch(entry.id, partner.id, common, entry.mode);
    return { partnerId: partner.id, common };
  }

  _findPartner(entry) {
    const queue = this.queues.get(entry.mode);
    let best = null;
    let bestCommon = [];
    let firstRandom = null;

    for (const candidate of queue.values()) {
      if (candidate.id === entry.id) continue;
      if (!this.canPair(entry.id, candidate.id)) continue;

      if (entry.interests.size && candidate.interests.size) {
        const common = [...entry.interests].filter((t) => candidate.interests.has(t));
        if (common.length > bestCommon.length) {
          best = candidate;
          bestCommon = common;
        }
      }
      if (!firstRandom && entry.randomOk && candidate.randomOk) firstRandom = candidate;
    }

    if (best) return { partner: best, common: bestCommon };
    if (firstRandom) return { partner: firstRandom, common: [] };
    return null;
  }
}

module.exports = { Matchmaker, normalizeInterests, MAX_INTERESTS, MAX_INTEREST_LENGTH, MODES };
