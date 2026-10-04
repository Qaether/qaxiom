import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'

const mathJaxVersion = createRequire(import.meta.url)('mathjax-full/package.json').version as string

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    PACKAGE_VERSION: JSON.stringify(mathJaxVersion)
  },
  build: {
    chunkSizeWarningLimit: 500
  },
  test: {
    include: process.env.QAXIOM_REAL_EVAL ? ['scripts/evaluation/*.test.ts'] : ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts']
  }
})
