import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Read WITHOUT a prefix filter: the Socket credentials are kept under unprefixed names so a
  // hosting dashboard will store them as secrets, and inlined into the bundle here on purpose.
  const env = loadEnv(mode, process.cwd(), '')
  const inline = (name: string) => JSON.stringify(env[name] ?? '')

  return {
    plugins: [react()],
    define: {
      'import.meta.env.SOCKET_API_KEY': inline('SOCKET_API_KEY'),
      'import.meta.env.SOCKET_AFFILIATE': inline('SOCKET_AFFILIATE'),
      'import.meta.env.SOCKET_BASE': inline('SOCKET_BASE'),
    },
    build: {
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
              return 'react-vendor';
            }
            if (id.includes('node_modules/wagmi/') || id.includes('node_modules/viem/')) {
              return 'web3-vendor';
            }
          }
        }
      }
    }
  }
})
