import { getChainConfig } from '../config/chains'
import { T } from '../styles/theme'

interface ExplorerLinkProps {
  hash?: `0x${string}`
  chainId?: number
  label?: string
  /**
   * Drops the top margin, for a caller that owns its own spacing.
   *
   * The margin suits the usual position — trailing a block of content — but a grid cell that
   * centres its contents does not want it, and the history row was cancelling it with a
   * `marginTop: -8px` that had to stay equal to a number in this file.
   */
  inline?: boolean
}

/**
 * ExplorerLink — "View on Explorer" hyperlink for a submitted transaction.
 * Renders nothing until there is a hash. Resolves the block explorer from the
 * active chain config, falling back to Etherscan.
 */
export function ExplorerLink({ hash, chainId, label = 'View on Explorer', inline = false }: ExplorerLinkProps) {
  if (!hash) return null
  const explorerUrl = getChainConfig(chainId)?.explorerUrl ?? 'https://etherscan.io'
  return (
    <a
      href={`${explorerUrl}/tx/${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      style={{ display: 'inline-block', marginTop: inline ? 0 : T.space[2], fontSize: T.fontSize.sm, fontWeight: 600, color: T.primary, textDecoration: 'none' }}
    >
      {label} ↗
    </a>
  )
}
