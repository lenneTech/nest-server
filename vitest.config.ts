import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite()],
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts'],
    root: './',
  },
});
