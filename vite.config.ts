import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

/**
 * Offline web app (iPhone "Add to Home Screen", any browser): emit sw.js that precaches every
 * built file + the public assets, versioned by the hash of the file list + the worker template.
 */
function serviceWorker(): Plugin {
  return {
    name: 'fiberlens-sw',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const pub = ['manifest.webmanifest', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];
      const files = [...Object.keys(bundle).filter((f) => !f.endsWith('.map')), ...pub].filter((f) => f !== 'index.html');
      const template = fs.readFileSync('src/sw-template.js', 'utf8');
      const version = createHash('sha256').update(files.sort().join('|') + template).digest('hex').slice(0, 12);
      const src = template.replace('__VERSION__', version).replace('__FILES__', JSON.stringify(files));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, sourcemap: false },
  server: { port: 5180, fs: { strict: false } },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as any);
