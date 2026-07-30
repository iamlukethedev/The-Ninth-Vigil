import { Engine } from './core/Engine.js';
import { loadModules } from './game/modules.js';
import { applyScenario, SCENARIOS } from './game/Scenarios.js';

/** What the live game boots into when no ?shot= is given. */
const DEFAULT_SCENARIO = 'dungeon';

const params = new URLSearchParams(location.search);
const headless = params.has('headless');
const container = document.getElementById('app');

/* ---------- loading veil ---------- */
const veil = document.createElement('div');
veil.style.cssText = `position:fixed;inset:0;z-index:50;display:flex;align-items:center;
  justify-content:center;flex-direction:column;gap:18px;
  background:radial-gradient(ellipse at 50% 45%,#141017 0%,#08070b 55%,#000 100%);
  color:#b99a63;letter-spacing:.34em;font-size:13px;text-transform:uppercase;
  transition:opacity .9s ease;font-family:Georgia,serif`;
veil.innerHTML = `<div style="font-size:30px;letter-spacing:.5em;color:#c9a86a;
    text-shadow:0 0 34px rgba(190,120,40,.6),0 2px 0 #000">THE NINTH VIGIL</div>
  <div id="ldbar" style="width:340px;height:2px;background:#241d17;position:relative;overflow:hidden">
    <div id="ldfill" style="position:absolute;inset:0 100% 0 0;
      background:linear-gradient(90deg,#6b3d12,#d99a3c,#f3d08a);transition:right .25s ease"></div>
  </div>
  <div id="ldtxt" style="opacity:.5;font-size:10.5px">forging the world</div>`;
document.body.appendChild(veil);

const engine = new Engine(container);
window.engine = engine;

const setProgress = (p, label) => {
  const f = veil.querySelector('#ldfill');
  const t = veil.querySelector('#ldtxt');
  if (f) f.style.right = `${Math.max(0, 100 - p * 100).toFixed(1)}%`;
  if (t && label) t.textContent = label.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
};

const boot = (async () => {
  const { loaded, missing } = await loadModules(engine, (p, id) => setProgress(p * 0.4, id));
  console.info(`[nona] modules loaded: ${loaded.join(', ') || '(none)'}`);
  if (missing.length) console.info(`[nona] modules pending: ${missing.join(', ')}`);

  await engine.initAll((p, id) => setProgress(0.4 + p * 0.6, id));

  // A scenario is what configures fog, exposure, biome, weather, and spawns.
  // Without one every module sits in its raw constructed default, which renders
  // as an unlit, unfogged, un-graded mess. The harness applies one explicitly;
  // the live game must too.
  const requested = params.get('shot') ?? params.get('scenario');
  const startScenario = SCENARIOS[requested] ? requested : DEFAULT_SCENARIO;
  setProgress(0.97, startScenario);
  try {
    await applyScenario(engine, startScenario);
  } catch (e) {
    console.error('[nona] scenario failed', e);
  }

  // Warm shader compilation so the first real frames aren't a hitch.
  try { engine.renderer.compile(engine.scene, engine.camera); } catch {}

  setProgress(1, 'enter');
  if (!headless) {
    veil.style.opacity = '0';
    setTimeout(() => veil.remove(), 950);
    engine.start();
  } else {
    veil.remove();
  }
  // Failsafe: the veil must never outlive boot. If a transition never fires or a
  // hot-reload interrupts the timer above, this still clears it.
  setTimeout(() => veil.isConnected && veil.remove(), 4000);
  return { loaded, missing, scenario: startScenario };
})();

/* ---------- screenshot harness contract ---------- */
window.__NONA__ = {
  ready: false,
  version: '1.0.0',
  engine,
  async step(frames = 1, dt = 1 / 60) {
    await engine.step(frames, dt);
  },
  async scenario(name) {
    return applyScenario(engine, name);
  },
  stats() {
    return engine.profiler.snapshot();
  },
  modules() {
    return Array.from(engine._modules.keys());
  },
};

boot
  .then(({ loaded, missing }) => {
    window.__NONA__.loaded = loaded;
    window.__NONA__.missing = missing;
    window.__NONA__.ready = true;
  })
  .catch((e) => {
    console.error('[nona] boot failed', e);
    window.__NONA__.error = String(e?.stack ?? e);
    window.__NONA__.ready = true; // let the harness capture the failure state
  });
