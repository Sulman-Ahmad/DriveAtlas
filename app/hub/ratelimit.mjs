// Request rate limits and a sign-in lockout that grows with repeated wrong passwords.

export class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
    setInterval(() => this.prune(), windowMs).unref();
  }

  // Returns 0 if allowed, otherwise the number of seconds to wait.
  take(key) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || now - e.start >= this.windowMs) { e = { start: now, count: 0 }; this.hits.set(key, e); }
    e.count += 1;
    return e.count <= this.max ? 0 : Math.ceil((e.start + this.windowMs - now) / 1000);
  }

  prune() {
    const now = Date.now();
    for (const [k, e] of this.hits) if (now - e.start >= this.windowMs) this.hits.delete(k);
  }
}

// After 5 wrong passwords, each further attempt waits 30 s, then 60 s, 120 s ... up to 15 minutes.
export class LoginGuard {
  constructor({ freeTries = 5, baseMs = 30_000, maxMs = 15 * 60_000 } = {}) {
    Object.assign(this, { freeTries, baseMs, maxMs });
    this.state = new Map();
  }

  check(key) {
    const s = this.state.get(key);
    if (!s || !s.lockedUntil) return 0;
    const wait = s.lockedUntil - Date.now();
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }

  fail(key) {
    const s = this.state.get(key) || { count: 0, lockedUntil: 0 };
    s.count += 1;
    if (s.count >= this.freeTries) s.lockedUntil = Date.now() + Math.min(this.maxMs, this.baseMs * 2 ** (s.count - this.freeTries));
    this.state.set(key, s);
  }

  success(key) { this.state.delete(key); }
}
