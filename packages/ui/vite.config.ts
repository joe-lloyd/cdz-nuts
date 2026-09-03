import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Note the naming inversion, because it will confuse you otherwise:
//
//   static/  →  hand-written files copied verbatim (Vite's "publicDir")
//   public/  →  the BUILD OUTPUT (Vite's "outDir")
//
// Vite's convention is the opposite way round, but `public/` is the directory
// both consumers already read — music-dump serves it via routes.json and
// homelab-music embeds it with include_dir! — and renaming it would mean a
// coordinated change across two other repos in two languages for no gain.
export default defineConfig({
  plugins: [react()],
  publicDir: 'static',
  build: {
    outDir: 'public',
    emptyOutDir: true,
    // Fixed filenames, no content hashes. `test/routes.test.js` asserts that
    // public/ and routes.json name exactly the same files, and the Rust shell
    // reads that manifest to decide what to embed. Hashed names would break
    // both on every build. Nothing is lost: both consumers already send
    // `cache-control: no-cache`, so filename cache-busting was never doing any
    // work here.
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'app-[name].js',
        assetFileNames: (info) =>
          info.names?.some((n) => n.endsWith('.css')) ? 'app.css' : '[name][extname]',
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
  },
});
