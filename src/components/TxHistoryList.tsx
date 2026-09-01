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
import { RateLine } from './RateLine'
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
  /**
   * Realized USD P&L per LOWER-CASED transaction hash, from the cost-basis replay.
   *
   * Optional, and absent while Aave's indexer is still answering. A close with no figure shows
   * none rather than a zero — "made nothing" and "not worked out yet" are different statements.
   */
  realizedByTx?: Record<string, number>
}

/** Realized P&L, signed. The minus is U+2212, which lines up under a digit. */
function pnl(usd: number): string {
  const sign = usd < 0 ? '\u2212' : '+'
  return `${sign}$${Math.abs(usd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
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

function isDisplayZero(value: bigint, decimals: number | null): boolean {
  if (value === 0n) return true
  if (decimals === null) return false
  const places = Math.min(decimals, 6)
  const num = Number(formatUnits(value < 0n ? -value : value, decimals))
  return Number(num.toFixed(places)) === 0
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

function Row({ entry, chainId, realizedUsd }: {
  entry: TxHistoryEntry
  chainId: number
  realizedUsd?: number
}) {
  const { swap } = entry
  // Both directions, the toggle and the default orientation all live in RateLine, which the
  // settled panel in the open and close modals shares.
  const priced = swap && swap.srcDecimals !== null && swap.dstDecimals !== null

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(80px, auto) minmax(200px, 2fr) minmax(180px, 1.5fr) minmax(100px, 1fr) minmax(90px, auto) auto',
        alignItems: 'center',
        gap: T.space[4],
        padding: `${T.space[3]} 0`,
        borderTop: `1px solid ${T.border}`,
        fontSize: T.fontSize.sm,
      }}
    >
      {/* 1. Action Badge & Date */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <span style={{ 
          fontWeight: 600, 
          color: entry.kind === 'open' ? T.success : T.text,
          fontSize: T.fontSize.sm 
        }}>
          {entry.kind === 'open' ? 'Open' : 'Close'}
        </span>
        <span style={{ color: T.textMuted, fontSize: T.fontSize.xs, whiteSpace: 'nowrap' }}>
          {new Date(entry.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </span>
      </div>

      {/* 2. Swap Amounts (Primary Focus) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap', fontWeight: 500 }}>
        {swap ? (
          <>
            <span style={{ color: T.text }}>{amount(swap.spentAmount, swap.srcDecimals)}</span>
            <span style={{ color: T.textMuted }}>{swap.srcSymbol ?? shortAddress(swap.srcToken)}</span>
            <span style={{ color: T.textMuted, margin: '0 4px' }}>→</span>
            <span style={{ color: T.text }}>{amount(swap.returnAmount, swap.dstDecimals)}</span>
            <span style={{ color: T.textMuted }}>{swap.dstSymbol ?? shortAddress(swap.dstToken)}</span>
          </>
        ) : (
          <span style={{ color: T.textMuted }}>No swap recorded</span>
        )}
      </div>

      {/* 3. Rate Line */}
      <div style={{ color: T.textMuted, fontSize: T.fontSize.sm, whiteSpace: 'nowrap' }}>
        {swap && priced && swap.srcSymbol && swap.dstSymbol ? (
          <RateLine
            srcSymbol={swap.srcSymbol}
            srcDecimals={swap.srcDecimals!}
            dstSymbol={swap.dstSymbol}
            dstDecimals={swap.dstDecimals!}
            spentAmount={swap.spentAmount}
            returnAmount={swap.returnAmount}
          />
        ) : swap && entry.rate && swap.srcSymbol && swap.dstSymbol ? (
          <span>{`1 ${swap.srcSymbol} = ${rate(entry.rate)} ${swap.dstSymbol}`}</span>
        ) : null}
      </div>

      {/* 4. Slippage / Performance */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', whiteSpace: 'nowrap' }}>
        {entry.fill?.delta !== undefined && entry.fill.delta !== null && swap && swap.dstDecimals !== null && !isDisplayZero(entry.fill.delta, swap.dstDecimals) && (
          <span style={{ 
            fontSize: T.fontSize.xs,
            fontWeight: 500,
            padding: '2px 6px',
            borderRadius: T.radius.sm,
            // Two of the four hexes here were these tokens written longhand; the other two were
            // new shades that existed nowhere else, so they were the only colours in this
            // component that could not follow a theme change.
            backgroundColor: entry.fill.delta < 0n ? T.dangerBg : T.successBg,
            color: entry.fill.delta < 0n ? T.danger : T.success,
          }}>
            {`${entry.fill.delta > 0n ? '+' : '-'}${amount(entry.fill.delta < 0n ? -entry.fill.delta : entry.fill.delta, swap.dstDecimals)} ${swap.dstSymbol ?? shortAddress(swap.dstToken)}`}
          </span>
        )}
      </div>

      {/* 5. What this trade settled.

          Closes only, and deliberately: an open establishes a cost basis, it does not realize one,
          so a number here would be an opinion about a position still running. The figure is the
          whole transaction — a leveraged close settles on both legs, the collateral it sold and
          the debt it bought back, and both are booked against this hash. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', whiteSpace: 'nowrap' }}>
        {entry.kind === 'close' && realizedUsd !== undefined && (
          <span
            title="Realized against the average entry price this position had at the time"
            style={{
              fontWeight: 600,
              color: realizedUsd < 0 ? T.danger : T.success,
            }}
          >
            {pnl(realizedUsd)}
          </span>
        )}
      </div>

      {/* 6. Explorer Link */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', whiteSpace: 'nowrap' }}>
        <ExplorerLink hash={entry.hash as `0x${string}`} chainId={chainId} label="Explorer" inline />
      </div>
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
function SyncFooter({ sync, expanded, inline }: { sync: HistorySync; expanded: boolean; inline?: boolean }) {
  const { scanning, error } = sync.status
  // The button is for someone already looking at the list, or for someone who has just been told
  // the read failed. Offering it under a collapsed, working panel is noise.
  const offerResync = expanded || error !== null
  if (!scanning && !error && !offerResync) return null

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', 
        justifyContent: inline ? 'flex-end' : 'space-between',
        gap: T.space[3], 
        marginTop: inline ? 0 : T.space[2], 
        fontSize: T.fontSize.xs,
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
            background: 'transparent', padding: '4px 12px',
            color: scanning ? T.textMuted : T.primary,
            cursor: scanning ? 'default' : 'pointer',
            opacity: scanning ? 0.5 : 1, fontSize: T.fontSize.sm,
            fontWeight: 500,
          }}
        >
          Resync
        </button>
      )}
    </div>
  )
}

export function TxHistoryList({ wallet, chainId, sync, realizedByTx }: TxHistoryListProps) {
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
    <div style={{ 
      marginTop: T.space[4], fontSize: T.fontSize.sm,
      background: T.surface, border: `1px solid ${T.border}`,
      borderRadius: T.radius.lg, padding: T.space[4],
      boxShadow: T.shadow.sm
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={{
            border: 'none', background: 'none', padding: 0, cursor: 'pointer',
            color: T.text, fontWeight: 600, fontSize: T.fontSize.md,
            display: 'flex', alignItems: 'center', gap: T.space[1]
          }}
        >
          {open ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
          )}
          Recent activity ({entries.length})
        </button>

        {sync && <SyncFooter sync={sync} expanded={open} inline />}
      </div>

      {/* The row is a five-column grid of nowrap cells, so it has a hard minimum of about 624px.
          Below that it used to push the whole page sideways; it scrolls inside itself now. */}
      {open && (
        <div style={{ marginTop: T.space[2], overflowX: 'auto' }}>
          {shown.map((e) => (
            <Row
              key={`${e.chainId}:${e.hash}`}
              entry={e}
              chainId={chainId}
              realizedUsd={realizedByTx?.[e.hash.toLowerCase()]}
            />
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
