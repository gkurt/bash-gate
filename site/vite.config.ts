import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  // Relative asset paths, so the built site works from any folder (GitHub Pages, say).
  base: './',
  server: { port: 4194, strictPort: true },
  build: {
    rolldownOptions: { input: { main: page('index.html'), tutorial: page('tutorial.html') } },
  },
});
