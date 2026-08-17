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
import type { HistorySync } from '../hooks/useHistorySync'

interface TxHistoryListProps {
  wallet: Address | undefined
  chainId: number
  /**
   * The on-chain sync, when one is running. Optional: the list reads storage and is perfectly
   * correct without it — this only reports what the sync is doing and offers to run it again.
   */
  sync?: HistorySync
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

/** Rows per page. Five is what fits under a panel without becoming a second screen. */
const PAGE_SIZE = 5

function PageButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        border: `1px solid ${T.border}`, borderRadius: T.radius.sm,
        background: 'transparent', padding: '2px 8px',
        color: disabled ? T.textMuted : T.primary,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1, fontSize: T.fontSize.xs,
      }}
    >
      {label}
    </button>
  )
}

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

/**
 * What the sync is up to, and a way to make it start over.
 *
 * Deliberately quiet. A sync that is working is not news, so this renders only while a scan is in
 * flight or after one has failed — the Resync button appears alongside, because the moment a user
 * wants to force a re-read is the moment they have been told something went wrong.
 */
function SyncFooter({ sync, expanded }: { sync: HistorySync; expanded: boolean }) {
  const { scanning, error } = sync.status
  // The button is for someone already looking at the list, or for someone who has just been told
  // the read failed. Offering it under a collapsed, working panel is noise.
  const offerResync = expanded || error !== null
  if (!scanning && !error && !offerResync) return null

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: T.space[3], marginTop: T.space[2], fontSize: T.fontSize.xs,
      }}
    >
      <span style={{ color: error ? T.warning : T.textMuted }}>
        {error
          ? `Could not read the chain: ${error}`
          : scanning
            ? 'Checking the chain for older activity…'
            : ''}
      </span>
      {offerResync && (
        <button
          type="button"
          onClick={sync.resync}
          disabled={scanning}
          style={{
            border: `1px solid ${T.border}`, borderRadius: T.radius.sm,
            background: 'transparent', padding: '2px 8px',
            color: scanning ? T.textMuted : T.primary,
            cursor: scanning ? 'default' : 'pointer',
            opacity: scanning ? 0.5 : 1, fontSize: T.fontSize.xs,
          }}
        >
          Resync
        </button>
      )}
    </div>
  )
}

export function TxHistoryList({ wallet, chainId, sync }: TxHistoryListProps) {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(0)

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

  // Clamped rather than reset: a row written while the list is open shifts everything down one,
  // and a page that no longer exists would otherwise render empty.
  const lastPage = Math.max(0, Math.ceil(entries.length / PAGE_SIZE) - 1)
  const current = Math.min(page, lastPage)
  const from = current * PAGE_SIZE
  const shown = entries.slice(from, from + PAGE_SIZE)

  // A wallet with nothing recorded and nothing to report stays off the screen entirely. The one
  // exception is a sync that FAILED, because the user it failed for is the one who needs the
  // Resync button — and hiding the panel would leave them an empty screen and no way to retry.
  if (entries.length === 0 && !sync?.status.error) return null

  if (entries.length === 0 && sync) {
    return (
      <div style={{ marginTop: T.space[4], fontSize: T.fontSize.sm }}>
        <SyncFooter sync={sync} expanded={false} />
      </div>
    )
  }

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

      {sync && <SyncFooter sync={sync} expanded={open} />}

      {open && (
        <div style={{ marginTop: T.space[2] }}>
          {shown.map((e) => (
            <Row key={`${e.chainId}:${e.hash}`} entry={e} chainId={chainId} />
          ))}

          {/* Only when there is somewhere to page TO. One page of history needs no controls. */}
          {entries.length > PAGE_SIZE && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: T.space[3], marginTop: T.space[2], color: T.textMuted, fontSize: T.fontSize.xs,
            }}>
              <span>{`${from + 1}–${from + shown.length} of ${entries.length}`}</span>
              <span style={{ display: 'flex', gap: T.space[2] }}>
                <PageButton label="Previous" disabled={current === 0} onClick={() => setPage(current - 1)} />
                <PageButton label="Next" disabled={current === lastPage} onClick={() => setPage(current + 1)} />
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
