import { useEffect, useState } from 'react'

/**
 * Chain-slug → chainId map for URL routing.
 * Extend as more chains are supported.
 */
const URL_CHAIN_MAP: Record<string, number> = {
  eth: 1,
  ethereum: 1,
  mainnet: 1,
  sepolia: 11155111,
}

export interface ViewMode {
  viewAddress?: `0x${string}`
  viewChainId?: number
}

function parse(pathname: string): ViewMode {
  const m = pathname.match(/^\/(\w+)\/address\/(0x[a-fA-F0-9]{40})\/?$/)
  if (!m) return {}
  const chain = URL_CHAIN_MAP[m[1].toLowerCase()]
  if (!chain) return {}
  return {
    viewAddress: m[2].toLowerCase() as `0x${string}`,
    viewChainId: chain,
  }
}

/**
 * Reads `/eth/address/0x…` from the URL and re-parses on popstate.
 * Returns an empty object when no valid view URL is present.
 */
export function useViewMode(): ViewMode {
  const [state, setState] = useState<ViewMode>(() => parse(window.location.pathname))
  useEffect(() => {
    const onPop = () => setState(parse(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  return state
}

/** Navigate to a view URL without a page reload. */
export function navigateToView(chainSlug: string, address: string) {
  const url = `/${chainSlug}/address/${address}`
  window.history.pushState({}, '', url)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/** Return to the connected-wallet view (root URL). */
export function exitViewMode() {
  window.history.pushState({}, '', '/')
  window.dispatchEvent(new PopStateEvent('popstate'))
}
