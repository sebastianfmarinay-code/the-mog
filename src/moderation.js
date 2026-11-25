'use strict';

/**
 * In-memory report tracking and temporary bans, keyed by client address.
 *
 * Someone is banned for `banMs` once `threshold` *different* reporters have
 * reported them within `windowMs`. State lives in memory, so it resets when
 * the server restarts. Swap this for a shared store (Redis, a database) if you
 * run more than one server process.
 */
class Moderation {
  constructor({
    threshold = 3,
    windowMs = 24 * 60 * 60 * 1000,
    banMs = 60 * 60 * 1000,
    now = Date.now,
  } = {}) {
    this.threshold = threshold;
    this.windowMs = windowMs;
    this.banMs = banMs;
    this.now = now;
    this.reports = new Map(); // reportedKey -> Map(reporterKey -> timestamp)
    this.bans = new Map(); // key -> expiry timestamp
  }

  /** Milliseconds left on a ban, or 0 if not banned. */
  banRemaining(key) {
    const until = this.bans.get(key);
    if (!until) return 0;
    const left = until - this.now();
    if (left <= 0) {
      this.bans.delete(key);
      return 0;
    }
    return left;
  }

  /**
   * Record a report. Returns true if this report pushed the reported key over
   * the threshold and a ban was issued.
   */
  report(reportedKey, reporterKey) {
    const now = this.now();
    let byReporter = this.reports.get(reportedKey);
    if (!byReporter) {
      byReporter = new Map();
      this.reports.set(reportedKey, byReporter);
    }
    byReporter.set(reporterKey, now);
    for (const [reporter, at] of byReporter) {
      if (now - at > this.windowMs) byReporter.delete(reporter);
    }

    if (byReporter.size >= this.threshold && !this.banRemaining(reportedKey)) {
      this.bans.set(reportedKey, now + this.banMs);
      this.reports.delete(reportedKey);
      return true;
    }
    return false;
  }

  /** Drop expired bans and stale reports. Call periodically. */
  prune() {
    const now = this.now();
    for (const [key, until] of this.bans) if (until <= now) this.bans.delete(key);
    for (const [key, byReporter] of this.reports) {
      for (const [reporter, at] of byReporter) {
        if (now - at > this.windowMs) byReporter.delete(reporter);
      }
      if (!byReporter.size) this.reports.delete(key);
    }
  }
}

module.exports = { Moderation };
