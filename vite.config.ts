import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  // Read WITHOUT a prefix filter: the credentials are unprefixed so they cannot be substituted
  // into the bundle. This config runs in Node, so the dev proxy below can hold them.
  const env = loadEnv(mode, process.cwd(), '')
  const key = env.SOCKET_API_KEY
  const affiliate = env.SOCKET_AFFILIATE
  // The dedicated host rejects a key without an affiliate, so it takes both or neither.
  const keyed = Boolean(key && affiliate)
  const socketHost = keyed ? 'https://dedicated-backend.socket.tech' : 'https://public-backend.socket.tech'
  if (command === 'serve') {
    console.log(`socket: ${socketHost}  key:${key ? 'yes' : 'no'}  affiliate:${affiliate ? 'yes' : 'no'}`)
  }

  return {
    plugins: [react()],
    define: { 'import.meta.env.SOCKET_BASE': JSON.stringify(env.SOCKET_BASE ?? '') },
    server: {
      // Locally, the same path api/socket/[...path].js serves deployed.
      proxy: {
        '/api/socket': {
          target: socketHost,
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/api\/socket/, ''),
          headers: {
            ...(affiliate ? { affiliate } : {}),
            ...(keyed ? { 'x-api-key': key } : {}),
          },
        },
      },
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
