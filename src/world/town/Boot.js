/**
 * SANCTUM — Town boot shim.
 *
 * DIAGNOSIS (why the hub had no settlement): `src/world/Town.js` and its whole
 * `src/world/town/*` builder set existed and were correct, but **nothing ever
 * loaded them**. `src/game/modules.js` walks a fixed MANIFEST; `town` is not in
 * it, and no manifest module imports Town, so the class was never constructed,
 * never inited, and never received `applyScenario('hub')`. Proof: the `hub`
 * capture's profiler listed modules render/water/hero/hud/director/loot/sky/
 * props/terrain/ai/lighting/weather — no `town`, no `npcs`. Not off-camera, not
 * mis-scaled, not disposed on the wrong scenario: simply never instantiated.
 *
 * THE FIX, without editing an integrator-owned file. This module runs as its own
 * `<script type="module">` **before** `/src/main.js` (the tag is injected by the
 * tiny `sanctum-town-boot` plugin in vite.config.js — no source rewriting, no
 * edit to index.html, main.js, Engine.js, modules.js or Scenarios.js). ES module
 * namespaces are singletons, so the `MANIFEST` array mutated here is literally
 * the array `loadModules()` is about to walk a tick later. Town therefore
 * self-registers into the manifest, and `Town.init()` in turn self-registers
 * `npcs` via `engine.register()`, which is the documented late-registration path.
 *
 * Idempotent: if a future manifest lists `town` explicitly this is a no-op, and
 * `Engine.add()` is itself idempotent by id.
 */
import { MANIFEST } from '../../game/modules.js';

const ENTRY = { id: 'town', path: '/src/world/Town.js', export: 'Town' };

try {
  if (Array.isArray(MANIFEST) && !MANIFEST.some((e) => e && e.id === ENTRY.id)) {
    // Slot it directly after `props`: the world section stays contiguous, Town
    // inits with assets/terrain/lighting already constructed, and it updates
    // well before `render` composites the frame.
    const after = MANIFEST.findIndex((e) => e && e.id === 'props');
    const before = MANIFEST.findIndex((e) => e && e.id === 'render');
    const at = after >= 0 ? after + 1 : before >= 0 ? before : MANIFEST.length;
    MANIFEST.splice(at, 0, ENTRY);
  }
} catch (e) {
  console.error('[town:boot] could not register Town —', e);
}
