import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  // acad-ts entities are identified by constructor.name in the importer: minification must keep class names
  esbuild: { keepNames: true },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, sourcemap: false },
  server: { port: 5180, fs: { strict: false } },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as any);
