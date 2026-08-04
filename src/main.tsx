import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { config } from './config/wagmi'
import App from './App'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      /**
       * TanStack Query defaults to `staleTime: 0`, meaning every query is stale the moment
       * it resolves. Eight components mount `useAavePositions`, so each mount — and every
       * window focus — re-fired the whole read set even though the answers cannot have
       * changed. A short window collapses those into one round-trip.
       *
       * 4s is deliberately well under mainnet's ~12s block time: chain state cannot change
       * within the window, and a transaction takes at least a block to confirm, so a
       * post-transaction remount is always past the window and still refetches. Nothing here
       * calls invalidateQueries, so that property is what keeps balances correct after a
       * supply/borrow/repay — do not raise this without adding explicit invalidation.
       *
       * Allowance reads use explicit refetch() after approve, which ignores staleTime.
       */
      staleTime: 4_000,
      gcTime: 5 * 60_000,
      retry: 2,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
)