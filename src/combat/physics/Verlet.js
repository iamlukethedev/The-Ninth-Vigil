/**
 * THE NINTH VIGIL — shared Verlet / position-based constraint solver.
 *
 * One solver, three customers: ragdolls (bone chains with joint limits), cloth
 * (cloaks, banners, webs) and rope (chains, hanging lanterns). Exposed on the
 * physics module as `physics.verlet(opts)` / `physics.cloth(opts)` /
 * `physics.rope(opts)` so no other module has to write its own — every extra
 * integrator in the project is another chance for the frame to stop being
 * byte-deterministic.
 *
 * Why position-based rather than force-based
 * -----------------------------------------
 * A corpse is the hardest case in the whole physics layer: it has ~20 bodies,
 * ~19 joints and it must never explode, never jitter and never bend a knee
 * backwards. A force-based articulated solver needs high stiffness to hold a
 * bone length, and high stiffness is exactly what makes an explicit integrator
 * blow up. Projecting positions onto the constraint manifold cannot add energy,
 * so the worst case is "too stiff to look organic" instead of "corpse launched
 * into orbit". Every constraint below is a pure projection.
 *
 * Determinism contract
 * --------------------
 *   • fixed substep count, fixed iteration count, fixed solve order
 *   • constraints solved in insertion order, always, both directions
 *   • no Math.random, no wall clock, no Map/Set iteration over object keys
 *   • all state in Float32Array/Int32Array — no accumulation-order surprises
 *     from property enumeration
 *
 * Storage layout: positions and previous positions are flat xyz triples.
 * Velocity is implicit (p - prev), which is what makes collision response free:
 * moving a particle out of a wall *is* the velocity change.
 */

const EPS = 1e-8;

/** Constraint kinds, in the order the solver runs them. */
export const C_DIST = 0;   // exact / range length between two particles
export const C_CONE = 1;   // child segment inside a cone about a transported ref
export const C_HINGE = 2;  // child segment on a hinge plane, signed angle limits
export const C_PIN = 3;    // particle pinned to a moving anchor

export class Verlet {
  /**
   * @param {object} [o]
   * @param {number} [o.capacity]   initial particle capacity
   * @param {number} [o.substeps]   integration substeps per step() (fixed)
   * @param {number} [o.iterations] constraint sweeps per substep (fixed)
   * @param {number[]} [o.gravity]  m/s^2
   * @param {number} [o.damping]    velocity retained per second (0.02 = heavy)
   * @param {number} [o.maxSpeed]   clamp, metres/second — the explosion guard
   */
  constructor(o = {}) {
    const cap = Math.max(4, o.capacity ?? 32);
    this.cap = cap;
    this.n = 0;

    this.p = new Float32Array(cap * 3);      // position
    this.q = new Float32Array(cap * 3);      // previous position
    this.a = new Float32Array(cap * 3);      // per-particle accumulated accel
    this.im = new Float32Array(cap);         // inverse mass (0 = pinned)
    this.r = new Float32Array(cap);          // collision radius
    this.flags = new Uint8Array(cap);        // 1 = grounded this step

    /* constraints, struct-of-arrays, insertion ordered */
    this.cKind = [];
    this.cA = [];      // particle a  (child tip, for angular)
    this.cB = [];      // particle b  (joint,    for angular)
    this.cC = [];      // particle c  (parent,   for angular)
    this.cF = [];      // numeric payload arrays (Float64 for exactness)
    this.cN = 0;

    this.substeps = Math.max(1, o.substeps ?? 2);
    this.iterations = Math.max(1, o.iterations ?? 4);
    this.gravity = new Float64Array(o.gravity ?? [0, -9.81, 0]);
    this.damping = o.damping ?? 0.06;
    this.maxSpeed = o.maxSpeed ?? 26;
    /**
     * Relaxation on the *angular* limits. A joint limit is a hard inequality, and
     * projecting it fully on every iteration is what makes an articulated PBD
     * chain oscillate: the limit throws the tip, the bone-length constraint
     * throws it back, and the pair trade a growing position error that appears
     * as velocity on the next substep. Under-relaxing turns the limit into a
     * stiff-but-finite constraint, which converges instead of ringing.
     */
    this.angRelax = o.angRelax ?? 0.5;
    /** @type {null|((solver:Verlet, i:number, x:number, y:number, z:number, r:number)=>void)} */
    this.collide = null;
    /** Scratch the collide callback writes into; avoids returning objects. */
    this.hit = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, hit: false, friction: 0.6 };
    this.motion = 0;      // mean |p - prev| over the last step, metres
    this.sleeping = false;
  }

  /* ------------------------------------------------------------ build */

  _grow(want) {
    if (want <= this.cap) return;
    let cap = this.cap;
    while (cap < want) cap *= 2;
    const p = new Float32Array(cap * 3); p.set(this.p);
    const q = new Float32Array(cap * 3); q.set(this.q);
    const a = new Float32Array(cap * 3); a.set(this.a);
    const im = new Float32Array(cap); im.set(this.im);
    const r = new Float32Array(cap); r.set(this.r);
    const f = new Uint8Array(cap); f.set(this.flags);
    this.p = p; this.q = q; this.a = a; this.im = im; this.r = r; this.flags = f;
    this.cap = cap;
  }

  /**
   * @param {number} x @param {number} y @param {number} z
   * @param {{mass?:number, radius?:number, pinned?:boolean}} [o]
   * @returns {number} particle index
   */
  add(x, y, z, o = {}) {
    this._grow(this.n + 1);
    const i = this.n++;
    const k = i * 3;
    this.p[k] = x; this.p[k + 1] = y; this.p[k + 2] = z;
    this.q[k] = x; this.q[k + 1] = y; this.q[k + 2] = z;
    const m = o.pinned ? 0 : Math.max(1e-3, o.mass ?? 1);
    this.im[i] = o.pinned ? 0 : 1 / m;
    this.r[i] = o.radius ?? 0.05;
    return i;
  }

  setPinned(i, pinned) { this.im[i] = pinned ? 0 : (this.im[i] || 1); }

  /** Absolute velocity write (m/s), expressed through the previous position. */
  setVelocity(i, vx, vy, vz, dt = 1 / 60) {
    const k = i * 3;
    this.q[k] = this.p[k] - vx * dt;
    this.q[k + 1] = this.p[k + 1] - vy * dt;
    this.q[k + 2] = this.p[k + 2] - vz * dt;
  }

  addVelocity(i, vx, vy, vz, dt = 1 / 60) {
    const k = i * 3;
    this.q[k] -= vx * dt;
    this.q[k + 1] -= vy * dt;
    this.q[k + 2] -= vz * dt;
  }

  velocity(i, out, dt = 1 / 60) {
    const k = i * 3, inv = 1 / dt;
    out.x = (this.p[k] - this.q[k]) * inv;
    out.y = (this.p[k + 1] - this.q[k + 1]) * inv;
    out.z = (this.p[k + 2] - this.q[k + 2]) * inv;
    return out;
  }

  /** Exact-length link. `stiff` 0..1; `slack` allows a range [rest*(1-slack), rest]. */
  distance(a, b, rest = -1, stiff = 1, slack = 0) {
    if (rest < 0) rest = this.dist(a, b);
    const i = this.cN++;
    this.cKind[i] = C_DIST;
    this.cA[i] = a; this.cB[i] = b; this.cC[i] = -1;
    this.cF[i] = new Float64Array([rest, stiff, slack]);
    return i;
  }

  /**
   * Cone limit. The segment b->a must stay within `half` radians of a reference
   * direction that is carried along by the parent segment c->b (minimal
   * rotation transport), so the limit is *relative* — exactly what a joint is.
   *
   * @param {number} a child tip particle
   * @param {number} b joint particle
   * @param {number} c parent (grandparent joint) particle
   * @param {number} half cone half-angle, radians
   * @param {number[]} refParent unit parent direction at rest (world, at build)
   * @param {number[]} refChild  unit child direction at rest (world, at build)
   * @param {number} [bias] 0..1 how much of the correction the tip takes
   */
  cone(a, b, c, half, refParent, refChild, bias = 0.86) {
    const i = this.cN++;
    this.cKind[i] = C_CONE;
    this.cA[i] = a; this.cB[i] = b; this.cC[i] = c;
    this.cF[i] = new Float64Array([
      half, bias,
      refParent[0], refParent[1], refParent[2],
      refChild[0], refChild[1], refChild[2],
    ]);
    return i;
  }

  /**
   * Hinge limit. The segment b->a is projected onto the plane whose normal is
   * the transported hinge axis (with `lateral` radians of slop so the corpse
   * does not read as a machine), then its signed bend about that axis is
   * clamped to [lo, hi]. This is what stops a knee from inverting.
   */
  hinge(a, b, c, lo, hi, lateral, refParent, refChild, refAxis, bias = 0.86) {
    const i = this.cN++;
    this.cKind[i] = C_HINGE;
    this.cA[i] = a; this.cB[i] = b; this.cC[i] = c;
    this.cF[i] = new Float64Array([
      lo, hi, lateral, bias,
      refParent[0], refParent[1], refParent[2],
      refChild[0], refChild[1], refChild[2],
      refAxis[0], refAxis[1], refAxis[2],
    ]);
    return i;
  }

  /** Pin a particle to an anchor that another system moves (cloak shoulders). */
  pin(a, x, y, z, stiff = 1) {
    const i = this.cN++;
    this.cKind[i] = C_PIN;
    this.cA[i] = a; this.cB[i] = -1; this.cC[i] = -1;
    this.cF[i] = new Float64Array([x, y, z, stiff]);
    return i;
  }

  /** Move a pin's anchor (call before step()). */
  setPin(ci, x, y, z) {
    const f = this.cF[ci];
    if (!f) return;
    f[0] = x; f[1] = y; f[2] = z;
  }

  dist(a, b) {
    const i = a * 3, j = b * 3;
    const dx = this.p[j] - this.p[i], dy = this.p[j + 1] - this.p[i + 1], dz = this.p[j + 2] - this.p[i + 2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /* ------------------------------------------------------------ accel */

  clearAccel() { this.a.fill(0, 0, this.n * 3); }

  accel(i, x, y, z) {
    const k = i * 3;
    this.a[k] += x; this.a[k + 1] += y; this.a[k + 2] += z;
  }

  /* ------------------------------------------------------------- step */

  /**
   * Advance by `dt`. Substeps and iteration counts are fixed at construction,
   * so two runs of the same scene produce bit-identical output.
   */
  step(dt) {
    if (this.sleeping || this.n === 0) { this.motion = 0; return; }
    const sub = this.substeps;
    const h = dt / sub;
    const drag = Math.pow(this.damping, h);          // per-substep retention
    const gx = this.gravity[0], gy = this.gravity[1], gz = this.gravity[2];
    const hh = h * h;
    const maxStep = this.maxSpeed * h;
    let motion = 0;

    for (let s = 0; s < sub; s++) {
      /* ---- integrate ---- */
      for (let i = 0; i < this.n; i++) {
        if (this.im[i] === 0) continue;
        const k = i * 3;
        let vx = (this.p[k] - this.q[k]) * drag;
        let vy = (this.p[k + 1] - this.q[k + 1]) * drag;
        let vz = (this.p[k + 2] - this.q[k + 2]) * drag;
        // clamp per-substep travel: the single guard that makes an exploding
        // constraint impossible rather than merely unlikely
        const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (sp > maxStep) { const f = maxStep / sp; vx *= f; vy *= f; vz *= f; }
        this.q[k] = this.p[k]; this.q[k + 1] = this.p[k + 1]; this.q[k + 2] = this.p[k + 2];
        this.p[k] += vx + (gx + this.a[k]) * hh;
        this.p[k + 1] += vy + (gy + this.a[k + 1]) * hh;
        this.p[k + 2] += vz + (gz + this.a[k + 2]) * hh;
      }

      /* ---- constraints ---- */
      for (let it = 0; it < this.iterations; it++) {
        this._solveAll(it === this.iterations - 1);
      }

      /* ---- world collision ---- */
      if (this.collide) {
        for (let i = 0; i < this.n; i++) {
          if (this.im[i] === 0) continue;
          const k = i * 3;
          this.flags[i] = 0;
          this.collide(this, i, this.p[k], this.p[k + 1], this.p[k + 2], this.r[i]);
        }
      }
    }

    for (let i = 0; i < this.n; i++) {
      const k = i * 3;
      const dx = this.p[k] - this.q[k], dy = this.p[k + 1] - this.q[k + 1], dz = this.p[k + 2] - this.q[k + 2];
      motion += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    this.motion = motion / this.n;
  }

  /** One full constraint sweep. `last` lets range constraints tighten only once. */
  _solveAll(last) {
    const p = this.p, im = this.im;
    for (let c = 0; c < this.cN; c++) {
      const kind = this.cKind[c];
      const f = this.cF[c];
      if (kind === C_DIST) {
        const a = this.cA[c], b = this.cB[c];
        const wa = im[a], wb = im[b];
        const w = wa + wb;
        if (w < EPS) continue;
        const ka = a * 3, kb = b * 3;
        let dx = p[kb] - p[ka], dy = p[kb + 1] - p[ka + 1], dz = p[kb + 2] - p[ka + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < EPS) continue;
        const rest = f[0], stiff = f[1], slack = f[2];
        let target = rest;
        if (slack > 0) {
          const lo = rest * (1 - slack);
          if (d > rest) target = rest;
          else if (d < lo) target = lo;
          else continue;
        }
        const diff = ((d - target) / d) * stiff;
        const ca = (wa / w) * diff, cb = (wb / w) * diff;
        p[ka] += dx * ca; p[ka + 1] += dy * ca; p[ka + 2] += dz * ca;
        p[kb] -= dx * cb; p[kb + 1] -= dy * cb; p[kb + 2] -= dz * cb;
      } else if (kind === C_PIN) {
        const a = this.cA[c];
        if (im[a] === 0) continue;
        const ka = a * 3, st = f[3];
        p[ka] += (f[0] - p[ka]) * st;
        p[ka + 1] += (f[1] - p[ka + 1]) * st;
        p[ka + 2] += (f[2] - p[ka + 2]) * st;
      } else if (kind === C_CONE) {
        this._solveCone(c, f);
      } else if (kind === C_HINGE) {
        this._solveHinge(c, f, last);
      }
    }
  }

  /* --------------------------------------------------------- angular */

  /**
   * Minimal-rotation transport of `v` by the rotation that takes unit `f` to
   * unit `t`, written into `out` (a 3-slot scratch array). Rodrigues, branchless
   * apart from the antipodal guard, no quaternion allocation.
   */
  _transport(fx, fy, fz, tx, ty, tz, vx, vy, vz, out) {
    // axis = f x t, cos = f.t
    let ax = fy * tz - fz * ty, ay = fz * tx - fx * tz, az = fx * ty - fy * tx;
    const co = fx * tx + fy * ty + fz * tz;
    const s2 = ax * ax + ay * ay + az * az;
    if (s2 < 1e-12) {
      if (co > 0) { out[0] = vx; out[1] = vy; out[2] = vz; return out; }
      // antipodal: 180 deg about any axis perpendicular to f — pick the most
      // stable one deterministically
      const bx = Math.abs(fx) < 0.9 ? 1 : 0, by = Math.abs(fx) < 0.9 ? 0 : 1;
      ax = fy * 0 - fz * by; ay = fz * bx - fx * 0; az = fx * by - fy * bx;
      const l = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
      ax /= l; ay /= l; az /= l;
      const d = ax * vx + ay * vy + az * vz;
      out[0] = 2 * d * ax - vx; out[1] = 2 * d * ay - vy; out[2] = 2 * d * az - vz;
      return out;
    }
    const s = Math.sqrt(s2);
    ax /= s; ay /= s; az /= s;
    const ang = Math.atan2(s, co);
    const c = Math.cos(ang), sn = Math.sin(ang);
    const d = ax * vx + ay * vy + az * vz;
    const cx = ay * vz - az * vy, cy = az * vx - ax * vz, cz = ax * vy - ay * vx;
    out[0] = vx * c + cx * sn + ax * d * (1 - c);
    out[1] = vy * c + cy * sn + ay * d * (1 - c);
    out[2] = vz * c + cz * sn + az * d * (1 - c);
    return out;
  }

  /** Move tip `a` (and, by `1-bias`, joint `b`) so that b->a points along t. */
  _steer(a, b, tx, ty, tz, len, bias) {
    const p = this.p, im = this.im;
    const ka = a * 3, kb = b * 3;
    const wx = p[kb] + tx * len, wy = p[kb + 1] + ty * len, wz = p[kb + 2] + tz * len;
    let ex = wx - p[ka], ey = wy - p[ka + 1], ez = wz - p[ka + 2];
    const wa = im[a], wb = im[b];
    const tot = wa + wb;
    if (tot < EPS) return;
    const relax = this.angRelax;
    ex *= relax; ey *= relax; ez *= relax;
    // The tip carries `bias` of the correction; the joint absorbs the rest in
    // the opposite direction so the limb rotates about its middle instead of
    // whipping its end.
    const fa = bias * (wa / tot) * 2;
    const fb = (1 - bias) * (wb / tot) * 2;
    p[ka] += ex * fa; p[ka + 1] += ey * fa; p[ka + 2] += ez * fa;
    p[kb] -= ex * fb; p[kb + 1] -= ey * fb; p[kb + 2] -= ez * fb;
  }

  _solveCone(c, f) {
    const a = this.cA[c], b = this.cB[c], g = this.cC[c];
    const p = this.p;
    const ka = a * 3, kb = b * 3, kg = g * 3;
    let px = p[kb] - p[kg], py = p[kb + 1] - p[kg + 1], pz = p[kb + 2] - p[kg + 2];
    let pl = Math.sqrt(px * px + py * py + pz * pz);
    if (pl < 1e-5) return;
    px /= pl; py /= pl; pz /= pl;
    let cx = p[ka] - p[kb], cy = p[ka + 1] - p[kb + 1], cz = p[ka + 2] - p[kb + 2];
    const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (cl < 1e-5) return;
    cx /= cl; cy /= cl; cz /= cl;

    const t = _s3;
    this._transport(f[2], f[3], f[4], px, py, pz, f[5], f[6], f[7], t);
    const tl = Math.sqrt(t[0] * t[0] + t[1] * t[1] + t[2] * t[2]) || 1;
    const tx = t[0] / tl, ty = t[1] / tl, tz = t[2] / tl;

    const dot = cx * tx + cy * ty + cz * tz;
    const half = f[0];
    const lim = Math.cos(half);
    if (dot >= lim) return;
    // rotate c toward t until it sits exactly on the cone
    const ang = Math.acos(dot < -1 ? -1 : dot) - half;
    // axis = t x c
    let ax = ty * cz - tz * cy, ay = tz * cx - tx * cz, az = tx * cy - ty * cx;
    const s = Math.sqrt(ax * ax + ay * ay + az * az);
    if (s < 1e-7) return;
    ax /= s; ay /= s; az /= s;
    const co = Math.cos(-ang), sn = Math.sin(-ang);
    const dd = ax * cx + ay * cy + az * cz;
    const rx = ay * cz - az * cy, ry = az * cx - ax * cz, rz = ax * cy - ay * cx;
    const nx = cx * co + rx * sn + ax * dd * (1 - co);
    const ny = cy * co + ry * sn + ay * dd * (1 - co);
    const nz = cz * co + rz * sn + az * dd * (1 - co);
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    this._steer(a, b, nx / nl, ny / nl, nz / nl, cl, f[1]);
  }

  _solveHinge(c, f, last) {
    const a = this.cA[c], b = this.cB[c], g = this.cC[c];
    const p = this.p;
    const ka = a * 3, kb = b * 3, kg = g * 3;
    let px = p[kb] - p[kg], py = p[kb + 1] - p[kg + 1], pz = p[kb + 2] - p[kg + 2];
    const pl = Math.sqrt(px * px + py * py + pz * pz);
    if (pl < 1e-5) return;
    px /= pl; py /= pl; pz /= pl;
    let cx = p[ka] - p[kb], cy = p[ka + 1] - p[kb + 1], cz = p[ka + 2] - p[kb + 2];
    const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (cl < 1e-5) return;
    cx /= cl; cy /= cl; cz /= cl;

    /* transported hinge axis, orthogonalised against the live parent dir */
    const t = _s3;
    this._transport(f[4], f[5], f[6], px, py, pz, f[10], f[11], f[12], t);
    let hx = t[0], hy = t[1], hz = t[2];
    const hp = hx * px + hy * py + hz * pz;
    hx -= px * hp; hy -= py * hp; hz -= pz * hp;
    let hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
    if (hl < 1e-6) return;
    hx /= hl; hy /= hl; hz /= hl;

    /* split the child dir into hinge-plane and lateral parts */
    const lat = cx * hx + cy * hy + cz * hz;
    let ix = cx - hx * lat, iy = cy - hy * lat, iz = cz - hz * lat;
    let il = Math.sqrt(ix * ix + iy * iy + iz * iz);
    if (il < 1e-5) return;
    ix /= il; iy /= il; iz /= il;

    /* signed bend about the axis, measured from the parent direction */
    const dotpi = px * ix + py * iy + pz * iz;
    const crossDotH = (py * iz - pz * iy) * hx + (pz * ix - px * iz) * hy + (px * iy - py * ix) * hz;
    const ang = Math.atan2(crossDotH, dotpi);
    const lo = f[0], hi = f[1], latMax = f[2];
    const clamped = ang < lo ? lo : ang > hi ? hi : ang;
    const latClamp = lat > latMax ? latMax : lat < -latMax ? -latMax : lat;
    /* inside every limit — nothing to do. `last` is unused here on purpose: a
       hinge is an inequality, not a range that wants a final tighten. */
    if (clamped === ang && Math.abs(latClamp - lat) < 1e-6) { void last; return; }

    /* rebuild: parent rotated by the clamped angle about h, plus allowed lateral */
    const co = Math.cos(clamped), sn = Math.sin(clamped);
    // rotate p about h by `clamped`  (h ⟂ p, so the Rodrigues term drops out)
    const rx = hy * pz - hz * py, ry = hz * px - hx * pz, rz = hx * py - hy * px;
    let nx = px * co + rx * sn;
    let ny = py * co + ry * sn;
    let nz = pz * co + rz * sn;
    const keep = Math.sqrt(Math.max(0, 1 - latClamp * latClamp));
    nx = nx * keep + hx * latClamp;
    ny = ny * keep + hy * latClamp;
    nz = nz * keep + hz * latClamp;
    const nl2 = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    this._steer(a, b, nx / nl2, ny / nl2, nz / nl2, cl, f[3]);
  }

  /* ------------------------------------------------------------ damping */

  /**
   * Joint friction: remove a fraction `k` of the *relative* velocity across
   * every length constraint, momentum-conserving.
   *
   * This is the single most important line in the whole ragdoll. Global linear
   * damping slows a corpse down uniformly and still lets its limbs ring against
   * each other; damping the relative velocity across each bone removes exactly
   * the internal oscillation and leaves the body's overall motion untouched.
   * Physically it is what a corpse's joints are: sacks of tissue with enormous
   * viscous loss and no springiness at all.
   *
   * Implemented through the previous position, which is where a Verlet rig keeps
   * its velocity, so no separate velocity array is needed.
   */
  dampLinks(k = 0.35) {
    if (k <= 0) return;
    const p = this.p, q = this.q, im = this.im;
    for (let c = 0; c < this.cN; c++) {
      if (this.cKind[c] !== C_DIST) continue;
      const a = this.cA[c], b = this.cB[c];
      const wa = im[a], wb = im[b];
      const tot = wa + wb;
      if (tot < EPS) continue;
      const ka = a * 3, kb = b * 3;
      const rx = (p[kb] - q[kb]) - (p[ka] - q[ka]);
      const ry = (p[kb + 1] - q[kb + 1]) - (p[ka + 1] - q[ka + 1]);
      const rz = (p[kb + 2] - q[kb + 2]) - (p[ka + 2] - q[ka + 2]);
      const fa = (k * wa) / tot, fb = (k * wb) / tot;
      // v_a += f_a * rel  <=>  q_a -= f_a * rel
      q[ka] -= rx * fa; q[ka + 1] -= ry * fa; q[ka + 2] -= rz * fa;
      q[kb] += rx * fb; q[kb + 1] += ry * fb; q[kb + 2] += rz * fb;
    }
  }

  /** Scale every particle's velocity by `f` (through the previous position). */
  scaleVelocity(f) {
    const p = this.p, q = this.q;
    for (let i = 0; i < this.n; i++) {
      const k = i * 3;
      q[k] = p[k] - (p[k] - q[k]) * f;
      q[k + 1] = p[k + 1] - (p[k + 1] - q[k + 1]) * f;
      q[k + 2] = p[k + 2] - (p[k + 2] - q[k + 2]) * f;
    }
  }

  /* ------------------------------------------------------------ utils */

  /** Axis-aligned bounds of the live particles, into {min,max} arrays. */
  bounds(out) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < this.n; i++) {
      const k = i * 3, r = this.r[i];
      if (this.p[k] - r < x0) x0 = this.p[k] - r;
      if (this.p[k + 1] - r < y0) y0 = this.p[k + 1] - r;
      if (this.p[k + 2] - r < z0) z0 = this.p[k + 2] - r;
      if (this.p[k] + r > x1) x1 = this.p[k] + r;
      if (this.p[k + 1] + r > y1) y1 = this.p[k + 1] + r;
      if (this.p[k + 2] + r > z1) z1 = this.p[k + 2] + r;
    }
    out.minX = x0; out.minY = y0; out.minZ = z0;
    out.maxX = x1; out.maxY = y1; out.maxZ = z1;
    return out;
  }

  /** Freeze in place — a settled corpse costs nothing until it is released. */
  sleep() {
    this.sleeping = true;
    this.q.set(this.p.subarray(0, this.n * 3));
  }
  wake() { this.sleeping = false; }

  reset() {
    this.n = 0;
    this.cN = 0;
    this.cKind.length = 0; this.cA.length = 0; this.cB.length = 0;
    this.cC.length = 0; this.cF.length = 0;
    this.sleeping = false;
    this.motion = 0;
  }
}

const _s3 = new Float64Array(3);

/* ==================================================================== *
 * ready-made rigs
 * ==================================================================== */

/**
 * A pinned rectangular cloth sheet. `pins` marks the top row immovable; the
 * caller moves them with `setPin` each frame (a cloak's shoulder line).
 *
 * @returns {{solver:Verlet, cols:number, rows:number, pins:number[], index:(c:number,r:number)=>number}}
 */
export function makeCloth(o = {}) {
  const cols = Math.max(2, o.cols ?? 8);
  const rows = Math.max(2, o.rows ?? 10);
  const w = o.width ?? 0.9;
  const h = o.height ?? 1.1;
  const ox = o.x ?? 0, oy = o.y ?? 0, oz = o.z ?? 0;
  const solver = new Verlet({
    capacity: cols * rows,
    substeps: o.substeps ?? 2,
    iterations: o.iterations ?? 5,
    damping: o.damping ?? 0.10,
    gravity: o.gravity,
  });
  const index = (c, r) => r * cols + c;
  const mass = o.mass ?? 0.05;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      solver.add(
        ox + (c / (cols - 1) - 0.5) * w,
        oy - (r / (rows - 1)) * h,
        oz,
        { mass, radius: o.radius ?? 0.03, pinned: r === 0 }
      );
    }
  }
  const stretch = o.stretch ?? 1.0;
  const shear = o.shear ?? 0.55;
  const bend = o.bend ?? 0.28;
  /* structural */
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c + 1 < cols) solver.distance(index(c, r), index(c + 1, r), -1, stretch);
      if (r + 1 < rows) solver.distance(index(c, r), index(c, r + 1), -1, stretch);
    }
  }
  /* shear */
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      solver.distance(index(c, r), index(c + 1, r + 1), -1, shear);
      solver.distance(index(c + 1, r), index(c, r + 1), -1, shear);
    }
  }
  /* bend (skip-one) — what stops a cloak folding into a paper crease */
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c + 2 < cols; c++) solver.distance(index(c, r), index(c + 2, r), -1, bend);
  }
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r + 2 < rows; r++) solver.distance(index(c, r), index(c, r + 2), -1, bend);
  }
  const pins = [];
  for (let c = 0; c < cols; c++) pins.push(solver.pin(index(c, 0), solver.p[index(c, 0) * 3], solver.p[index(c, 0) * 3 + 1], solver.p[index(c, 0) * 3 + 2]));
  return { solver, cols, rows, pins, index };
}

/**
 * A hanging rope / chain. Link 0 is pinned to the anchor; use `setPin(rig.pin,…)`
 * to move it. Inextensible by construction (stiffness 1, 6 iterations).
 */
export function makeRope(o = {}) {
  const links = Math.max(2, o.links ?? 8);
  const len = o.length ?? 1.6;
  const seg = len / (links - 1);
  const solver = new Verlet({
    capacity: links,
    substeps: o.substeps ?? 2,
    iterations: o.iterations ?? 6,
    damping: o.damping ?? 0.05,
    gravity: o.gravity,
  });
  const x = o.x ?? 0, y = o.y ?? 0, z = o.z ?? 0;
  for (let i = 0; i < links; i++) {
    solver.add(x, y - i * seg, z, {
      mass: (o.mass ?? 0.4) * (i === links - 1 ? (o.tipMass ?? 2.2) : 1),
      radius: o.radius ?? 0.04,
      pinned: i === 0,
    });
  }
  for (let i = 0; i + 1 < links; i++) solver.distance(i, i + 1, seg, 1);
  for (let i = 0; i + 2 < links; i++) solver.distance(i, i + 2, seg * 1.94, o.bend ?? 0.16);
  const pinId = solver.pin(0, x, y, z);
  return { solver, links, seg, pin: pinId };
}

export default Verlet;
