import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5187, strictPort: true },
  preview: { port: 5188, strictPort: true },
  build: { target: 'esnext', sourcemap: true },
});
