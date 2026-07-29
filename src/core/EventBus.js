export class EventBus {
  constructor() {
    this._map = new Map();
    this._queue = [];
  }
  on(evt, fn) {
    let s = this._map.get(evt);
    if (!s) this._map.set(evt, (s = new Set()));
    s.add(fn);
    return () => this.off(evt, fn);
  }
  once(evt, fn) {
    const off = this.on(evt, (p) => {
      off();
      fn(p);
    });
    return off;
  }
  off(evt, fn) {
    this._map.get(evt)?.delete(fn);
  }
  emit(evt, payload) {
    const s = this._map.get(evt);
    if (!s) return;
    for (const fn of s) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`[bus:${evt}]`, e);
      }
    }
  }
  /** Deferred emit — flushed at end of frame, safe for reentrancy. */
  post(evt, payload) {
    this._queue.push([evt, payload]);
  }
  flush() {
    if (!this._queue.length) return;
    const q = this._queue;
    this._queue = [];
    for (const [e, p] of q) this.emit(e, p);
  }
  clear() {
    this._map.clear();
    this._queue.length = 0;
  }
}
