/**
 * What this wallet has already done on this chain, read back from local history.
 *
 * Collapsed by default. The rows answer one question — what did that swap actually cost me — and
 * that is a question asked occasionally, not one worth a permanent block of screen.
 */
import { useMemo, useState, useSyncExternalStore } from 'react'
import { formatUnits, type Address } from 'viem'
import { browserStorage } from '../lib/delegationCache'
import { historyVersion, loadHistory, subscribeHistory, type TxHistoryEntry } from '../lib/txHistory'
import { ExplorerLink } from './ExplorerLink'
import { T } from '../styles/theme'

interface TxHistoryListProps {
  wallet: Address | undefined
  chainId: number
}

/** Rates carry their own precision from `quoteRate`; this only groups the thousands. */
function rate(value: string): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  return n >= 1
    ? n.toLocaleString(undefined, { maximumFractionDigits: 4 })
    : n.toLocaleString(undefined, { maximumSignificantDigits: 6 })
}

function amount(value: bigint, decimals: number | null): string {
  if (decimals === null) return `${value} raw units`
  const places = Math.min(decimals, 6)
  return Number(formatUnits(value, decimals)).toLocaleString(undefined, {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  })
}

const shortAddress = (token: Address) => `${token.slice(0, 6)}…${token.slice(-4)}`

function Row({ entry, chainId }: { entry: TxHistoryEntry; chainId: number }) {
  const { swap } = entry
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: T.space[1],
        padding: `${T.space[2]} 0`, borderTop: `1px solid ${T.border}`,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: T.space[3] }}>
        <span style={{ fontWeight: 600 }}>{entry.kind === 'open' ? 'Open' : 'Close'}</span>
        <span style={{ color: T.textMuted, fontSize: T.fontSize.xs }}>
          {new Date(entry.at).toLocaleString()}
        </span>
      </div>

      {swap && entry.rate && swap.srcSymbol && swap.dstSymbol ? (
        <span>{`1 ${swap.srcSymbol} = ${rate(entry.rate)} ${swap.dstSymbol}`}</span>
      ) : (
        <span style={{ color: T.textMuted }}>No swap recorded on this transaction</span>
      )}

      {swap && (
        <span style={{ color: T.textMuted, fontSize: T.fontSize.xs }}>
          {`${amount(swap.spentAmount, swap.srcDecimals)} ${swap.srcSymbol ?? shortAddress(swap.srcToken)}`}
          {' → '}
          {`${amount(swap.returnAmount, swap.dstDecimals)} ${swap.dstSymbol ?? shortAddress(swap.dstToken)}`}
        </span>
      )}

      {entry.fill?.percent !== null && entry.fill !== null && (
        <span style={{ fontSize: T.fontSize.xs, color: entry.fill.delta < 0n ? T.warning : T.success }}>
          {`${Math.abs(entry.fill.percent!).toFixed(4)}% ${entry.fill.delta < 0n ? 'below' : 'above'} the quote`}
        </span>
      )}

      <ExplorerLink hash={entry.hash as `0x${string}`} chainId={chainId} label="View" />
    </div>
  )
}

export function TxHistoryList({ wallet, chainId }: TxHistoryListProps) {
  const [open, setOpen] = useState(false)

  /**
   * Subscribed, not read once.
   *
   * A row is written from an effect, which runs AFTER the render that would have displayed it,
   * and nothing renders again afterwards — so reading storage once left the transaction just
   * settled invisible until a reload. The store announces its writes instead. The snapshot is a
   * number, which React can compare by identity; the rows are rebuilt only when it moves.
   *
   * Still derived during render rather than pushed into state from an effect: `browserStorage`
   * answers null for a store that is absent or refuses to be read, and `loadHistory` never throws.
   */
  const version = useSyncExternalStore(subscribeHistory, historyVersion, historyVersion)
  const entries = useMemo(() => {
    // The dependency that does the work, as in `useLeverageOpen`'s `storageTick`: nothing about
    // the READ changes when a row is written, only the bytes behind it.
    void version
    return wallet ? loadHistory(browserStorage(), { wallet, chainId }) : []
  }, [wallet, chainId, version])

  if (entries.length === 0) return null

  return (
    <div style={{ marginTop: T.space[4], fontSize: T.fontSize.sm }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          border: 'none', background: 'none', padding: 0, cursor: 'pointer',
          color: T.textMuted, fontWeight: 600, fontSize: T.fontSize.sm,
        }}
      >
        {open ? '▾' : '▸'} Recent activity ({entries.length})
      </button>

      {open && (
        <div style={{ marginTop: T.space[2] }}>
          {entries.map((e) => (
            <Row key={`${e.chainId}:${e.hash}`} entry={e} chainId={chainId} />
          ))}
        </div>
      )}
    </div>
  )
}
