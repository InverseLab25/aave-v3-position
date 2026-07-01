import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'react-vendor';
          }
          if (id.includes('node_modules/wagmi/') || id.includes('node_modules/viem/')) {
            return 'web3-vendor';
          }
          if (id.includes('node_modules/@apollo/')) {
            return 'apollo-vendor';
          }
        }
      }
    }
  }
})
