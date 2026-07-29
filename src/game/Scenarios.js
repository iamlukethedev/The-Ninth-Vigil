/**
 * Deterministic scenario setup for the screenshot critic. Integrator-owned.
 *
 * Each scenario poses the world, camera, weather, and actors so the same
 * `--scenario=X --frames=N` always yields the same frame. Modules opt in by
 * listening for the 'scenario' bus event or implementing `applyScenario(name)`.
 */
export const SCENARIOS = {
  hub: {
    desc: 'Town hub at dusk — safe zone, braziers, NPCs, establishing wide.',
    env: { biome: 'town', timeOfDay: 0.78, weather: 'clear', fog: 0.35 },
    camera: { pitch: 52, dist: 30, yaw: 35, fov: 42, target: [0, 0, 0] },
    spawn: { enemies: 0, npcs: 6, props: 'dense' },
    exposure: 1.05,
  },
  overworld: {
    desc: 'Open exterior vista — storm light, distant silhouettes, deep fog.',
    env: { biome: 'moor', timeOfDay: 0.62, weather: 'overcast', fog: 0.55 },
    camera: { pitch: 46, dist: 42, yaw: -20, fov: 48, target: [0, 0, 0] },
    spawn: { enemies: 5, npcs: 0, props: 'scattered' },
    exposure: 1.0,
  },
  dungeon: {
    desc: 'Crypt interior — torchlight, volumetric shafts, wet stone.',
    env: { biome: 'crypt', timeOfDay: 0, weather: 'none', fog: 0.7, interior: true },
    camera: { pitch: 56, dist: 24, yaw: 0, fov: 44, target: [0, 0, 0] },
    spawn: { enemies: 4, npcs: 0, props: 'dense' },
    exposure: 1.25,
  },
  combat: {
    desc: 'Mid-fight — pack of enemies, abilities firing, blood, impacts.',
    env: { biome: 'crypt', timeOfDay: 0, weather: 'none', fog: 0.6, interior: true },
    camera: { pitch: 54, dist: 26, yaw: 12, fov: 46, target: [0, 0, 0] },
    spawn: { enemies: 9, npcs: 0, props: 'dense' },
    script: 'fight',
    exposure: 1.2,
  },
  boss: {
    desc: 'Boss arena — huge silhouette, ground telegraph, full spectacle.',
    env: { biome: 'hell', timeOfDay: 0, weather: 'ember', fog: 0.5, interior: true },
    camera: { pitch: 50, dist: 36, yaw: 0, fov: 50, target: [0, 0, -4] },
    spawn: { enemies: 1, boss: true, npcs: 0, props: 'arena' },
    script: 'bossfight',
    exposure: 1.15,
  },
  night: {
    desc: 'Night exterior — moonlight, emissive sources, rain.',
    env: { biome: 'moor', timeOfDay: 0.02, weather: 'rain', fog: 0.6 },
    camera: { pitch: 50, dist: 30, yaw: 60, fov: 46, target: [0, 0, 0] },
    spawn: { enemies: 6, npcs: 0, props: 'scattered' },
    exposure: 1.35,
  },
  closeup: {
    desc: 'Hero close-up — armor, cloth, skin, weapon material detail.',
    env: { biome: 'crypt', timeOfDay: 0, weather: 'none', fog: 0.25, interior: true },
    camera: { pitch: 22, dist: 6.5, yaw: 145, fov: 35, target: [0, 1.1, 0] },
    spawn: { enemies: 0, npcs: 0, props: 'sparse' },
    exposure: 1.1,
  },
  inventory: {
    desc: 'Inventory + character sheet — full UI craft check.',
    env: { biome: 'town', timeOfDay: 0.8, weather: 'clear', fog: 0.3 },
    camera: { pitch: 52, dist: 28, yaw: 35, fov: 42, target: [0, 0, 0] },
    spawn: { enemies: 0, npcs: 2, props: 'dense' },
    ui: { inventory: true, characterSheet: true, tooltipOn: 'weapon' },
    exposure: 1.05,
  },
};

export async function applyScenario(engine, name) {
  const cfg = SCENARIOS[name] ?? SCENARIOS.combat;
  engine.scenario = { name, ...cfg };
  engine.renderer.toneMappingExposure = cfg.exposure ?? 1.0;

  // Let every module react. Direct hook first, then the bus.
  for (const [, m] of engine._modules) {
    if (m.__dead) continue;
    try { await m.applyScenario?.(name, cfg); } catch (e) { console.error('[scenario]', e); }
  }
  engine.bus.emit('scenario', { name, cfg });

  // Settle: let streaming/GPU upload/particle warmup finish deterministically.
  for (let i = 0; i < 30; i++) engine.tick(1 / 60);
  return cfg;
}
