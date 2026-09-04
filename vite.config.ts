import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  // Read WITHOUT a prefix filter, deliberately. `SOCKET_API_KEY` has no `VITE_` on it so that it
  // cannot be substituted into the bundle; this config runs in Node, so it can hold the key that
  // the browser must never see.
  const env = loadEnv(mode, process.cwd(), '')
  const key = env.SOCKET_API_KEY
  const affiliate = env.SOCKET_AFFILIATE
  // The dedicated host rejects a key without an affiliate ("Affiliate header is required"), so
  // it takes both or neither.
  const keyed = Boolean(key && affiliate)
  const socketHost = keyed
    ? 'https://dedicated-backend.socket.tech'
    : 'https://public-backend.socket.tech'
  // Printed because there is no way to tell the two apart from the browser: the request URL is
  // `/api/socket/...` either way, and landing on the public host looks like a 429 rather than
  // like a missing key. Reads the UNPREFIXED names, so a key set as `VITE_SOCKET_KEY` is
  // invisible here and this line says so.
  if (command === 'serve') {
    console.log(`socket: ${socketHost}  key:${key ? 'yes' : 'no'}  affiliate:${affiliate ? 'yes' : 'no'}`)
  }

  return {
    plugins: [react()],
    server: {
      /**
       * Socket's keyed API, proxied for local development.
       *
       * Not a convenience. `dedicated-backend.socket.tech` answers a CORS preflight with 403 and
       * no `access-control-allow-*` headers at all, so a browser cannot reach it however the
       * request is built — and `public-backend` only allows `affiliate` through CORS, never
       * `x-api-key`. The keyed host is reachable from a server or not at all.
       *
       * Worth the trouble because the unkeyed host takes 20bps of the input out of every route.
       * Deployed, this same path needs a serverless function; nothing here ships to production.
       */
      proxy: {
        '/api/socket': {
          // Dedicated where there are credentials to send, public otherwise, so `/api/socket`
          // always answers in dev and a missing key degrades to the unkeyed host rather than
          // to a 403 that reads like Socket being down.
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
