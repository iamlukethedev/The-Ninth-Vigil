import * as THREE from 'three';

/**
 * Pointer + keyboard state. Ground-plane raycast is cached per frame.
 * In headless/screenshot mode the harness can inject synthetic state so
 * scenarios can pose the game without a real user.
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
      d.setPointerCapture?.(e.pointerId);
    });
    d.addEventListener('pointerup', (e) => {
      this.buttons.delete(e.button);
      this._justReleased.add(`mouse${e.button}`);
    });
    d.addEventListener('contextmenu', (e) => e.preventDefault());
    d.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
    addEventListener('keydown', (e) => {
      const k = e.code;
      if (!this.keys.has(k)) this._justPressed.add(k);
      this.keys.add(k);
      if (['Tab', 'Space', 'KeyI', 'KeyC', 'KeyS'].includes(k)) e.preventDefault();
    });
    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this._justReleased.add(e.code);
    });
    addEventListener('blur', () => { this.keys.clear(); this.buttons.clear(); });
  }

  down(btn = 0) { return this.buttons.has(btn); }
  pressed(code) { return this.keys.has(code); }
  justPressed(code) { return this._justPressed.has(code); }
  justReleased(code) { return this._justReleased.has(code); }

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
