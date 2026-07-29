/**
 * Module manifest + load order. Integrator-owned — agents must NOT edit this.
 *
 * Modules are imported dynamically and skipped if the file does not exist yet,
 * so the game always boots even while parts are still being built.
 *
 * ORDER MATTERS. Simulation flows: assets -> world -> actors -> combat ->
 * physics -> camera -> vfx -> ui -> render (render must be last so it composites
 * everything produced this tick).
 */
export const MANIFEST = [
  // --- foundation ---
  { id: 'assets',    path: '/src/core/AssetForge.js',      export: 'AssetForge' },

  // --- environment ---
  { id: 'sky',       path: '/src/render/Sky.js',           export: 'Sky' },
  { id: 'lighting',  path: '/src/render/Lighting.js',      export: 'Lighting' },
  { id: 'terrain',   path: '/src/world/Terrain.js',        export: 'Terrain' },
  { id: 'water',     path: '/src/world/Water.js',          export: 'Water' },
  { id: 'dungeon',   path: '/src/world/Dungeon.js',        export: 'Dungeon' },
  { id: 'props',     path: '/src/world/Props.js',          export: 'Props' },
  { id: 'weather',   path: '/src/render/Weather.js',       export: 'Weather' },

  // --- actors ---
  { id: 'hero',      path: '/src/chars/Hero.js',           export: 'Hero' },
  { id: 'bestiary',  path: '/src/chars/Bestiary.js',       export: 'Bestiary' },
  { id: 'ai',        path: '/src/game/AI.js',              export: 'AI' },

  // --- systems ---
  { id: 'combat',    path: '/src/combat/CombatSystem.js',  export: 'CombatSystem' },
  { id: 'physics',   path: '/src/combat/Physics.js',       export: 'Physics' },
  { id: 'loot',      path: '/src/game/Loot.js',            export: 'Loot' },
  { id: 'director',  path: '/src/game/Director.js',        export: 'Director' },
  { id: 'camera',    path: '/src/game/CameraRig.js',       export: 'CameraRig' },

  // --- presentation ---
  { id: 'vfx',       path: '/src/vfx/VFXSystem.js',        export: 'VFXSystem' },
  { id: 'decals',    path: '/src/vfx/Decals.js',           export: 'Decals' },
  { id: 'audio',     path: '/src/audio/AudioEngine.js',    export: 'AudioEngine' },
  { id: 'hud',       path: '/src/ui/HUD.js',               export: 'HUD' },

  // --- must be last ---
  { id: 'render',    path: '/src/render/RenderPipeline.js', export: 'RenderPipeline' },
];

/**
 * `import.meta.glob` only ever matches files that actually exist, so a module
 * that hasn't been written yet is simply absent from LOADERS instead of
 * exploding Vite's import analysis. This is what lets the game boot at any
 * point during the build-out.
 */
const LOADERS = import.meta.glob('/src/{core,render,world,chars,combat,vfx,game,ui,audio}/*.js');

export async function loadModules(engine, onProgress) {
  const loaded = [];
  const missing = [];
  for (let i = 0; i < MANIFEST.length; i++) {
    const entry = MANIFEST[i];
    onProgress?.(i / MANIFEST.length, entry.id);
    const loader = LOADERS[entry.path];
    if (!loader) { missing.push(entry.id); continue; }
    try {
      const mod = await loader();
      const Cls = mod[entry.export] ?? mod.default;
      if (typeof Cls !== 'function') throw new Error(`no export '${entry.export}'`);
      if (!Cls.id) Cls.id = entry.id;
      engine.add(Cls);
      loaded.push(entry.id);
    } catch (e) {
      missing.push(entry.id);
      console.warn(`[module:${entry.id}] failed to load —`, e.message);
    }
  }
  return { loaded, missing };
}
