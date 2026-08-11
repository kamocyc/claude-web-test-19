import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@railsim/core': r('../../packages/core/src/index.ts'),
      '@railsim/data': r('../../packages/data/src/index.ts'),
      '@railsim/audio': r('../../packages/audio/src/index.ts'),
    },
  },
  server: { host: true },
  build: { target: 'es2022', outDir: 'dist' },
});
