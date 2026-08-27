import { useEffect, useState } from 'react'
import { CHAIN_CONFIGS } from '../config/chains'

/**
 * Chain slug → chainId, derived from the app's own chain registry rather than restated here.
 *
 * It used to be a hand-written list, and it stopped at Ethereum while the app itself grew to
 * eight chains — so `/base/address/0x…` matched no slug, fell through to "not a view URL", and
 * silently showed the connected wallet instead of the account asked for. Deriving it means a
 * chain is viewable exactly when the rest of the app can read it, and a chain added to
 * CHAIN_CONFIGS needs nothing done here.
 */
const CHAIN_SLUGS: Record<string, number> = {
  // Short forms already in circulation, and not derivable from a chain's display name.
  eth: 1,
  mainnet: 1,
  ...Object.fromEntries(
    Object.entries(CHAIN_CONFIGS).map(([id, config]) => [slugify(config.name), Number(id)]),
  ),
}

/** 'BNB Chain' → 'bnb-chain'. Spaces become hyphens; the route pattern below allows them. */
function slugify(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-')
}

interface ViewMode {
  viewAddress?: `0x${string}`
  viewChainId?: number
}

function parse(pathname: string): ViewMode {
  // `[\w-]`, not `\w`: a two-word chain slugs with a hyphen, which `\w` cannot match.
  const m = pathname.match(/^\/([\w-]+)\/address\/(0x[a-fA-F0-9]{40})\/?$/)
  if (!m) return {}
  const chain = CHAIN_SLUGS[m[1].toLowerCase()]
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

/** Return to the connected-wallet view (root URL). */
export function exitViewMode() {
  window.history.pushState({}, '', '/')
  window.dispatchEvent(new PopStateEvent('popstate'))
}
