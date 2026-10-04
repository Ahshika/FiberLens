import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, sourcemap: false },
  server: { port: 5180, fs: { strict: false } },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as any);
