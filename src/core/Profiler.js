/** Lightweight CPU profiler + renderer stats snapshot. */
export class Profiler {
  constructor(engine) {
    this.engine = engine;
    this.marks = new Map();
    this._t0 = 0;
    this._cur = null;
    this.frameMs = 0;
    this._hist = new Float32Array(120);
    this._hi = 0;
    this.enabled = true;
  }
  begin(name) {
    if (!this.enabled) return;
    this._cur = name;
    this._t0 = this._now();
  }
  end() {
    if (!this.enabled || !this._cur) return;
    const dt = this._now() - this._t0;
    const m = this.marks.get(this._cur) ?? { ms: 0, ema: 0 };
    m.ms = dt;
    m.ema = m.ema * 0.9 + dt * 0.1;
    this.marks.set(this._cur, m);
    this._cur = null;
  }
  mark(name, fn) {
    this.begin(name);
    try { fn(); } finally { this.end(); }
  }
  _now() {
    return typeof performance !== 'undefined' ? performance.now() : 0;
  }
  frame(ms) {
    this.frameMs = ms;
    this._hist[this._hi = (this._hi + 1) % this._hist.length] = ms;
  }
  percentile(p = 0.99) {
    const a = Array.from(this._hist).filter((v) => v > 0).sort((x, y) => x - y);
    return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
  }
  snapshot() {
    const r = this.engine.renderer.info;
    const avg = Array.from(this._hist).filter((v) => v > 0);
    return {
      fps: this.frameMs > 0 ? +(1000 / this.frameMs).toFixed(1) : 0,
      frameMs: +this.frameMs.toFixed(2),
      p99Ms: +this.percentile(0.99).toFixed(2),
      avgMs: avg.length ? +(avg.reduce((a, b) => a + b, 0) / avg.length).toFixed(2) : 0,
      calls: r.render.calls,
      tris: r.render.triangles,
      programs: r.programs?.length ?? 0,
      geometries: r.memory.geometries,
      textures: r.memory.textures,
      modules: Object.fromEntries(
        Array.from(this.marks, ([k, v]) => [k, +v.ema.toFixed(3)])
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
      ),
    };
  }
}
