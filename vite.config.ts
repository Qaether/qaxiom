import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 500
  },
  test: {
    include: process.env.QAXIOM_REAL_EVAL ? ['scripts/evaluation/*.test.ts'] : ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts']
  }
})
