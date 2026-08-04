import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    // Hook tests render components, so they need a DOM. Pure-logic suites are unaffected
    // by running under jsdom, so one environment keeps the config simple.
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
