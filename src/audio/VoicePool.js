/**
 * SANCTUM — spatial voice pool.
 * ---------------------------------------------------------------------------
 * Panner nodes (especially HRTF ones) are the expensive part of Web Audio, so
 * they are pooled and reused. Generators (oscillators / buffer sources) are
 * created per shot — that is cheap — and every one of them is registered here so
 * the pool can hard-disconnect the whole graph when the voice expires. Nothing
 * leaks: a voice is reclaimed the first update after its scheduled end.
 *
 * Voice signal path
 *
 *   generators -> in(gain) -> lp(occlusion+air) -> panner -> dry bus
 *                                              \-> send(gain) -> wet bus
 *
 * Flat (non-positional) voices — UI, music one-shots, global stings — skip the
 * panner and use a StereoPanner for width instead, which costs almost nothing.
 */

const AIR_MAX = 20000;

export class Voice {
  constructor(pool, spatial) {
    const ctx = pool.ctx;
    this.pool = pool;
    this.spatial = spatial;
    this.busy = false;
    this.end = 0;
    this.priority = 0;
    this.tag = '';
    this.nodes = [];

    this.in = ctx.createGain();
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = AIR_MAX;
    this.lp.Q.value = 0.0001;
    this.send = ctx.createGain();
    this.send.gain.value = 0;

    this.in.connect(this.lp);

    if (spatial) {
      this.panner = ctx.createPanner();
      const p = this.panner;
      p.panningModel = pool.hrtf ? 'HRTF' : 'equalpower';
      p.distanceModel = 'inverse';
      p.refDistance = pool.refDistance;
      p.maxDistance = pool.maxDistance;
      p.rolloffFactor = pool.rolloff;
      p.coneInnerAngle = 360;
      this.head = p;
      this.lp.connect(p);
      p.connect(pool.dry);
    } else {
      this.stereo = ctx.createStereoPanner();
      this.head = this.stereo;
      this.lp.connect(this.stereo);
      this.stereo.connect(pool.dry);
    }
    this.lp.connect(this.send);
    if (pool.wet) this.send.connect(pool.wet);
  }

  /** Register a generator so it is disconnected when the voice is reclaimed. */
  keep(node) { this.nodes.push(node); return node; }

  _reset() {
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      try { n.disconnect(); } catch { /* already detached */ }
      if (typeof n.stop === 'function') { try { n.onended = null; } catch { /* frozen */ } }
    }
    this.nodes.length = 0;
    const t = this.pool.ctx.currentTime;
    try {
      this.in.gain.cancelScheduledValues(t);
      this.in.gain.value = 1;
      this.lp.frequency.cancelScheduledValues(t);
      this.lp.frequency.value = AIR_MAX;
      this.send.gain.cancelScheduledValues(t);
      this.send.gain.value = 0;
      if (this.stereo) { this.stereo.pan.cancelScheduledValues(t); this.stereo.pan.value = 0; }
    } catch { /* param teardown raced a suspend — harmless */ }
    this.busy = false;
    this.end = 0;
    this.tag = '';
  }

  dispose() {
    this._reset();
    try {
      this.in.disconnect(); this.lp.disconnect(); this.send.disconnect();
      this.panner?.disconnect(); this.stereo?.disconnect();
    } catch { /* context already closed */ }
  }
}

export class VoicePool {
  /**
   * @param {BaseAudioContext} ctx
   * @param {object} o { dry, wet, hrtf, max, maxFlat, refDistance, maxDistance, rolloff }
   */
  constructor(ctx, o = {}) {
    this.ctx = ctx;
    this.dry = o.dry;
    this.wet = o.wet ?? null;
    this.hrtf = o.hrtf !== false;
    this.max = o.max ?? 22;
    this.maxFlat = o.maxFlat ?? 10;
    this.refDistance = o.refDistance ?? 5.5;
    this.maxDistance = o.maxDistance ?? 110;
    this.rolloff = o.rolloff ?? 1.15;

    this.spatialVoices = [];
    this.flatVoices = [];
    this.active = 0;
    this.stolen = 0;
    this.dropped = 0;
    this.peakActive = 0;
  }

  /**
   * Grab a voice. Returns null when the pool is saturated with higher-priority
   * sound — the caller must tolerate that (a dropped footstep in a 30-voice
   * melee is inaudible anyway).
   */
  acquire(spatial, duration, priority = 0.5, tag = '') {
    const list = spatial ? this.spatialVoices : this.flatVoices;
    const cap = spatial ? this.max : this.maxFlat;
    const now = this.ctx.currentTime;

    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v.busy) return this._take(v, now, duration, priority, tag);
    }
    if (list.length < cap) {
      let v;
      try { v = new Voice(this, spatial); } catch { this.dropped++; return null; }
      list.push(v);
      return this._take(v, now, duration, priority, tag);
    }
    // Saturated: steal the lowest-priority voice that is closest to finishing.
    let best = null, bestScore = Infinity;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const score = v.priority * 100 + (v.end - now);
      if (score < bestScore) { bestScore = score; best = v; }
    }
    if (best && best.priority <= priority) {
      this.stolen++;
      best._reset();
      this.active = Math.max(0, this.active - 1);
      return this._take(best, now, duration, priority, tag);
    }
    this.dropped++;
    return null;
  }

  _take(v, now, duration, priority, tag) {
    v.busy = true;
    v.end = now + Math.max(0.03, duration);
    v.priority = priority;
    v.tag = tag;
    this.active++;
    if (this.active > this.peakActive) this.peakActive = this.active;
    return v;
  }

  /** Extend a voice's lifetime (recipes report their real tail length). */
  hold(v, until) { if (v && until > v.end) v.end = until; }

  /** Reclaim everything that has finished. Called once per frame. */
  update() {
    const now = this.ctx.currentTime;
    for (let k = 0; k < 2; k++) {
      const list = k === 0 ? this.spatialVoices : this.flatVoices;
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (v.busy && v.end <= now) { v._reset(); this.active = Math.max(0, this.active - 1); }
      }
    }
  }

  /** Position + occlusion for one spatial voice. */
  place(v, x, y, z, occlusion = 0, airHz = AIR_MAX) {
    if (!v || !v.panner) return;
    const p = v.panner;
    const t = this.ctx.currentTime;
    if (p.positionX) {
      p.positionX.setValueAtTime(x, t);
      p.positionY.setValueAtTime(y, t);
      p.positionZ.setValueAtTime(z, t);
    } else if (p.setPosition) {
      p.setPosition(x, y, z);
    }
    if (occlusion > 0.01 || airHz < AIR_MAX) {
      const oc = 20000 * Math.pow(0.055, occlusion);   // 20 kHz -> ~1.1 kHz fully blocked
      v.lp.frequency.setValueAtTime(Math.max(160, Math.min(oc, airHz)), t);
      if (occlusion > 0.01) v.in.gain.setValueAtTime(1 - occlusion * 0.55, t);
    }
  }

  dispose() {
    for (const v of this.spatialVoices) v.dispose();
    for (const v of this.flatVoices) v.dispose();
    this.spatialVoices.length = 0;
    this.flatVoices.length = 0;
    this.active = 0;
  }
}
