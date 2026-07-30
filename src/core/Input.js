import * as THREE from 'three';

/**
 * Pointer + keyboard state. Ground-plane raycast is cached per frame.
 * In headless/screenshot mode the harness can inject synthetic state so
 * scenarios can pose the game without a real user.
 *
 * The left mouse button is special, and this module is where that lives
 * ------------------------------------------------------------------------
 * In an isometric ARPG the left button carries TWO orders that the player
 * distinguishes purely by what the cursor is over: press over a body and it
 * means "attack that", press over open floor and it means "walk there". Those
 * two readings used to be resolved independently by two modules that never
 * spoke — `CombatSystem` took every `mouse0` as the basic-attack bind, `Hero`
 * took every `down(0)` as a destination — so a click on empty floor produced
 * both intents at once and the attack won, because an attack animation locks
 * locomotion. Holding the button to run made it permanent: the combo re-armed
 * every frame the button was down and the hero never took a step.
 *
 * Binding is an input concern, so the resolution lives here, once, and every
 * consumer keeps reading the API it already read:
 *
 *   `justPressed('mouse0')` / `down(0)`  the LMB *action* bind — true only when
 *                                        the click resolved to a target
 *   `moveOrder()`                        true while LMB is held over open floor
 *   `rawJustPressed` / `rawDown`         the physical button, unresolved
 *
 * Deciding what counts as a target needs game knowledge that core must not
 * import, so the game installs a resolver with `setPickProvider`. With no
 * provider (or a throwing one) the order falls back to `attack`, which is
 * byte-for-byte the pre-resolution behaviour — a missing provider must never
 * silently disarm the attack button.
 */
export class Input {
  constructor(engine, dom) {
    this.engine = engine;
    this.dom = dom;
    this.mouse = {
      x: 0, y: 0,
      ndc: new THREE.Vector2(),
      worldGround: new THREE.Vector3(),
      moved: false,
    };
    this.buttons = new Set();
    this.keys = new Set();
    this._justPressed = new Set();
    this._justReleased = new Set();
    this.wheel = 0;
    this.enabled = true;

    /**
     * Has a human touched the controls at any point this session? Latched, and
     * set ONLY from the real DOM listeners below — never from `inject()`. That
     * distinction is the whole point: anything mid-performance (the hero's
     * scenario script, the combat director's posing) can hand the body back the
     * instant a player takes over, while the screenshot harness — which never
     * dispatches an event — keeps its posed frames bit-identical.
     */
    this.userActed = false;

    /**
     * The left button's meaning this frame: 'attack' over a body, 'move' over
     * open floor, 'none' while the button is up. Resolved in `update()`.
     */
    this.order = 'none';
    /** What the resolver found under the cursor, for consumers that want it. */
    this.pickEntity = null;
    this._pickProvider = null;

    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._ray = new THREE.Raycaster();
    this._bind();
  }

  _bind() {
    const d = this.dom;
    const set = (e) => {
      const r = d.getBoundingClientRect();
      this.mouse.x = e.clientX - r.left;
      this.mouse.y = e.clientY - r.top;
      this.mouse.ndc.set((this.mouse.x / r.width) * 2 - 1, -(this.mouse.y / r.height) * 2 + 1);
      this.mouse.moved = true;
    };
    d.addEventListener('pointermove', set);
    d.addEventListener('pointerdown', (e) => {
      set(e);
      this.buttons.add(e.button);
      this._justPressed.add(`mouse${e.button}`);
      this.userActed = true;
      d.setPointerCapture?.(e.pointerId);
    });
    d.addEventListener('pointerup', (e) => {
      this.buttons.delete(e.button);
      this._justReleased.add(`mouse${e.button}`);
    });
    d.addEventListener('contextmenu', (e) => e.preventDefault());
    d.addEventListener('wheel', (e) => {
      this.wheel += Math.sign(e.deltaY);
      this.userActed = true;
      e.preventDefault();
    }, { passive: false });
    addEventListener('keydown', (e) => {
      const k = e.code;
      if (!this.keys.has(k)) this._justPressed.add(k);
      this.keys.add(k);
      this.userActed = true;
      if (['Tab', 'Space', 'KeyI', 'KeyC', 'KeyS'].includes(k)) e.preventDefault();
    });
    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this._justReleased.add(e.code);
    });
    addEventListener('blur', () => { this.keys.clear(); this.buttons.clear(); });
  }

  /**
   * Button 0 reports the LMB *action* bind, so it is false while the click is a
   * move order — see the class header. Every other button is the raw device.
   */
  down(btn = 0) { return btn === 0 ? this.order === 'attack' && this.buttons.has(0) : this.buttons.has(btn); }
  pressed(code) { return this.keys.has(code); }
  justPressed(code) {
    if (code === 'mouse0' && this.order !== 'attack') return false;
    return this._justPressed.has(code);
  }
  justReleased(code) { return this._justReleased.has(code); }

  /* ------------------------------------------------- resolved left-click order */

  /** True while the left button is held over open floor: walk there. */
  moveOrder() { return this.order === 'move'; }

  /** The physical button, unresolved. For interactions that are not orders. */
  rawDown(btn = 0) { return this.buttons.has(btn); }
  rawJustPressed(code) { return this._justPressed.has(code); }

  /**
   * Install the game's cursor resolver. `fn(ray, groundPoint)` returns
   * `{ kind: 'attack' | 'ground', entity }`. Called at most once per frame, and
   * only while the left button is actually down, so an idle frame costs nothing.
   */
  setPickProvider(fn) { this._pickProvider = typeof fn === 'function' ? fn : null; }

  /** Synthetic injection for deterministic scenarios. */
  inject({ ndc, buttons, keys } = {}) {
    if (ndc) this.mouse.ndc.set(ndc[0], ndc[1]);
    if (buttons) { this.buttons.clear(); buttons.forEach((b) => this.buttons.add(b)); }
    if (keys) { this.keys.clear(); keys.forEach((k) => this.keys.add(k)); }
  }

  update() {
    this._ray.setFromCamera(this.mouse.ndc, this.engine.camera);
    if (!this._ray.ray.intersectPlane(this._plane, this.mouse.worldGround)) {
      this._ray.ray.at(40, this.mouse.worldGround);
    }
    this._resolveOrder();
  }

  /**
   * Classify the left button into an order. Runs before any module updates (the
   * engine ticks `input.update()` first), so every consumer in the frame reads
   * one consistent answer instead of each re-deciding what the click meant.
   */
  _resolveOrder() {
    // A press and release inside one frame still has to resolve, so consult the
    // edge as well as the held state.
    if (!this.buttons.has(0) && !this._justPressed.has('mouse0')) {
      this.order = 'none';
      this.pickEntity = null;
      return;
    }
    let kind = null;
    let entity = null;
    if (this._pickProvider) {
      try {
        const r = this._pickProvider(this._ray.ray, this.mouse.worldGround);
        if (r) { kind = r.kind ?? null; entity = r.entity ?? null; }
      } catch { kind = null; entity = null; }
    }
    // Unresolved means "no provider, or the provider failed": fall back to the
    // attack bind, which is exactly how this button behaved before orders
    // existed. Failing the other way would silently disarm the LMB.
    this.order = kind === 'ground' ? 'move' : 'attack';
    this.pickEntity = this.order === 'attack' ? entity : null;
  }

  endFrame() {
    this._justPressed.clear();
    this._justReleased.clear();
    this.wheel = 0;
    this.mouse.moved = false;
  }

  /** Set the ground plane height for the raycast (terrain follows the hero). */
  setGroundHeight(y) { this._plane.constant = -y; }
}
