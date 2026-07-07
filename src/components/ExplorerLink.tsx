import { getChainConfig } from '../config/chains'
import { T } from '../styles/theme'

interface ExplorerLinkProps {
  hash?: `0x${string}`
  chainId?: number
  label?: string
}

/**
 * ExplorerLink — "View on Explorer" hyperlink for a submitted transaction.
 * Renders nothing until there is a hash. Resolves the block explorer from the
 * active chain config, falling back to Etherscan.
 */
export function ExplorerLink({ hash, chainId, label = 'View on Explorer' }: ExplorerLinkProps) {
  if (!hash) return null
  const explorerUrl = getChainConfig(chainId)?.explorerUrl ?? 'https://etherscan.io'
  return (
    <a
      href={`${explorerUrl}/tx/${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      style={{ display: 'inline-block', marginTop: T.space[2], fontSize: T.fontSize.sm, fontWeight: 600, color: T.primary, textDecoration: 'none' }}
    >
      {label} ↗
    </a>
  )
}
