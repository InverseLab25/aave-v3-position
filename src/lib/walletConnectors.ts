import type { Connector } from 'wagmi'

/**
 * The wallets actually worth offering, out of everything wagmi reports.
 *
 * A plain function in its own file rather than a hook beside the component: the two rules below
 * are the whole of the picker's logic and they are worth testing without mounting a provider.
 *
 * Two things arrive that should not be shown. The connector already in use, because connecting
 * through it again throws `ConnectorAlreadyConnectedError` rather than doing nothing — which the
 * user sees as the modal refusing to close for no stated reason. And the same wallet twice:
 * EIP-6963 discovery is on by default in wagmi, so an installed wallet announces itself under
 * its real name, and any connector configured explicitly for it arrives alongside as a second
 * entry for one provider.
 *
 * Order is preserved, so the surviving entry of a duplicate pair is the discovered one, which is
 * the one carrying the wallet's own name and icon.
 */
export function usableConnectors(
  connectors: readonly Connector[],
  active: Connector | undefined,
): Connector[] {
  const seen = new Set<string>()
  return connectors.filter((connector) => {
    if (active && connector.id === active.id) return false
    const key = connector.name.trim().toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
