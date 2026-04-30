import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import VueRouter from 'unplugin-vue-router/vite'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8')) as {
  version: string
}

const electronExternals = [
  'electron',
  'fs',
  'fs/promises',
  'path',
  'os',
  'url',
  'pdfjs-dist',
  'pdfjs-dist/legacy/build/pdf.js',
  'pdfjs-dist/legacy/build/pdf.worker.js',
  'pdf-lib',
]

export default defineConfig({
  plugins: [
    VueRouter({
      routesFolder: 'src/pages',
      dts: 'src/typed-router.d.ts',
    }),
    vue(),
    tailwindcss(),
  ],
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist-renderer',
    emptyOutDir: true,
    target: 'chrome120',
    rollupOptions: {
      external: electronExternals,
      output: {
        format: 'cjs',
      },
    },
  },
  optimizeDeps: {
    exclude: electronExternals,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
