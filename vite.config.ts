import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = import.meta.dirname

// The UI is a static site served by the Lumen service (src/service/server.ts) on 127.0.0.1:6743.
export default defineConfig({
  root: resolve(root, 'src/renderer'),
  base: '/',
  publicDir: resolve(root, 'resources/public'),
  plugins: [react()],
  build: {
    outDir: resolve(root, 'out/renderer'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000
  }
})
