import { defineConfig } from 'vite';

/**
 * Injects the Town boot shim (src/world/town/Boot.js) as a module script that
 * runs before /src/main.js. Town is not in the integrator-owned MANIFEST and no
 * manifest module imports it, so without this tag the whole settlement is dead
 * code. The shim only pushes an entry onto the exported MANIFEST array — see the
 * header comment in src/world/town/Boot.js. Nothing in src/game, src/core,
 * index.html or tools is modified.
 */
const townBoot = {
  name: 'nona-town-boot',
  transformIndexHtml() {
    return [
      {
        tag: 'script',
        attrs: { type: 'module', src: '/src/world/town/Boot.js' },
        injectTo: 'head-prepend',
      },
    ];
  },
};

export default defineConfig({
  plugins: [townBoot],
  server: { port: 5187, strictPort: true },
  preview: { port: 5188, strictPort: true },
  build: { target: 'esnext', sourcemap: true },
});
