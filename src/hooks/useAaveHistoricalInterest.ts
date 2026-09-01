import { useMemo, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useConnection, useChainId } from 'wagmi'
import { formatUnits, type Address } from 'viem'
import { getChainConfig } from '../config/chains'
import { browserStorage } from '../lib/delegationCache'
import { swapFills, type SwapFills } from '../lib/swapFills'
import { isVolatilePrice } from '../utils/liquidation'
import { historyVersion, loadHistory, subscribeHistory, type TxHistoryEntry } from '../lib/txHistory'
import {
  readHistorySnapshot,
  userHistoryQuery,
  type HistoryItem,
} from '../lib/aaveUserHistory'

type CostBasis = {
  /** Weighted-average USD entry price of the tokens still held/owed. */
  avgEntryPriceUsd: number
  /**
   * Realized USD P&L from exits against the position that is STILL OPEN.
   *
   * Not lifetime, deliberately. A row describes the position on screen — its units, its average
   * entry, its yield — and bolting the result of a position closed out weeks ago onto it made
   * the row's total describe nothing at all: 179,096 of realized profit sitting beside 400 WETH
   * bought last Tuesday, reading as that position's gain.
   *
   * A position that goes to zero takes its result with it. What each of those closes made is
   * still reported, per transaction, against the transaction itself — see `realizedByTx`, which
   * is what Recent activity shows.
   */
  realizedPnlUsd: number
}

type Accumulator = {
  /** Every unit acquired, priced or not. This is the net principal. */
  totalUnits: number
  /**
   * Units whose execution price the indexer actually reported — the denominator for the average
   * entry price, and deliberately NOT `totalUnits`.
   *
   * Kept separate because the two questions have different answers. An entry the indexer prices
   * at 0 (very old, or unknown) still moved tokens, so it belongs in the principal; but folding
   * it into the average at a cost of nothing drags that average toward zero, which inflates
   * apparent unrealized gain. Excluding it from `totalUnits` instead would understate the
   * principal and overstate interest earned. Only splitting them gets both right.
   */
  pricedUnits: number
  totalCostUsd: number
  /** Realized since this position was last at zero. See {@link CostBasis.realizedPnlUsd}. */
  realizedPnlUsd: number
}

const newAcc = (): Accumulator => ({
  totalUnits: 0,
  pricedUnits: 0,
  totalCostUsd: 0,
  realizedPnlUsd: 0,
})

/** Weighted-average USD entry price over the units we have a price for. */
const avgEntryOf = (acc: Accumulator): number =>
  acc.pricedUnits > 0 ? acc.totalCostUsd / acc.pricedUnits : 0

/** A swap fill, converted to the dollars the rest of this ledger is counted in. */
interface FillUsd {
  units: number
  usdPerUnit: number
}

/** Every oracle price one item carries, written into `into` keyed by lower-cased token. */
function notePrices(tx: HistoryItem, into: Record<string, number>): void {
  const note = (address: string | undefined, usdPerToken: unknown) => {
    const price = Number(usdPerToken || 0)
    if (!address || !(price > 0)) return
    into[address.toLowerCase()] = price
  }
  note(tx.reserve?.underlyingToken.address, tx.amount?.usdPerToken)
  note(tx.collateral?.reserve.underlyingToken.address, tx.collateral?.amount.usdPerToken)
  note(tx.debtRepaid?.reserve.underlyingToken.address, tx.debtRepaid?.amount.usdPerToken)
}

/**
 * Every token's oracle price per transaction, as the indexer reported it.
 *
 * A fill is a fact about two tokens — 2,434.35 USDC per WETH — and this ledger is in dollars, so
 * one of them has to be priced to cross over. This is that price, taken from the SAME transaction
 * as the fill rather than from today: converting last week's trade at today's peg is not a
 * correction, it is a different error, and it is the one that made a 1,875.7568 USDC fill read as
 * $1,875.5712 and stop matching the transaction it came from.
 *
 * A liquidation is somebody else's transaction and carries no hash, so its legs land under nothing
 * and never match a fill. That is right: no swap of ours filled it.
 */
function oraclePricesByTx(items: readonly HistoryItem[]): Record<string, Record<string, number>> {
  const byTx: Record<string, Record<string, number>> = {}
  for (const tx of items) {
    if (!tx.txHash) continue
    notePrices(tx, (byTx[tx.txHash.toLowerCase()] ??= {}))
  }
  return byTx
}

/**
 * The collateral withdrawals Aave's indexer does not report, recovered from our own rows.
 *
 * `userTransactionHistory` omits a withdraw whose destination is a CONTRACT. A leveraged close
 * withdraws collateral to the strategies contract, sells it and repays out of the proceeds — so
 * the repay comes back from the indexer and the withdraw never does. Measured on a real Base
 * account: two withdrawals reported out of six, and a ledger claiming 700.31 WETH and 885,778
 * USDC still supplied against an actual 400.52 WETH and nothing.
 *
 * That is not a small error. Those phantom units keep their old cost in the weighted average and
 * price every position opened afterwards, and they realize nothing when the position that held
 * them was closed months ago.
 *
 * The amount is the swap's source leg, which is what the contract withdrew: it sells exactly what
 * it took out. The two disagree by the dust the router left behind — 0.017653 USDC on an
 * 885,774 USDC close — which is far below anything this ledger reports.
 *
 * Only ever ADDS what is missing. A pair the indexer already reports is left alone, so the day
 * Aave starts reporting these, nothing here counts them twice.
 *
 * Deliberately only the withdraw. The other three legs are reported correctly and could not be
 * recovered from a swap anyway: an open's supply includes margin the swap never saw, and a close
 * repays only what was owed rather than everything the swap bought.
 */
export function withCloseWithdrawals(
  items: readonly HistoryItem[],
  history: readonly TxHistoryEntry[],
): HistoryItem[] {
  const reported = new Set<string>()
  const lastIndexOf = new Map<string, number>()
  items.forEach((tx, i) => {
    const hash = tx.txHash?.toLowerCase()
    if (!hash) return
    lastIndexOf.set(hash, i)
    if (tx.__typename === 'UserWithdrawTransaction' && tx.reserve) {
      reported.add(`${hash}:${tx.reserve.underlyingToken.address.toLowerCase()}`)
    }
  })

  // Keyed by the index to insert after, so each lands beside the transaction it belongs to. The
  // indexer returns items in order, so following that transaction's own legs is following the
  // ledger's order — and a close whose hash the indexer never mentions at all is skipped, because
  // there is no position in the sequence that could be argued for.
  const missing = new Map<number, HistoryItem[]>()
  for (const entry of history) {
    const { swap } = entry
    if (entry.kind !== 'close' || !swap || swap.srcDecimals === null) continue
    const hash = entry.hash.toLowerCase()
    if (reported.has(`${hash}:${swap.srcToken.toLowerCase()}`)) continue
    const at = lastIndexOf.get(hash)
    if (at === undefined) continue

    const list = missing.get(at) ?? []
    list.push({
      __typename: 'UserWithdrawTransaction',
      txHash: entry.hash,
      // No `usdPerToken`, deliberately: the exit price for this is the rate the collateral was
      // actually SOLD at, which `fillUsd` reads off the same swap. There is no oracle read to
      // stand in for it here, and inventing one would be the error this whole path exists to fix.
      amount: { amount: { value: formatUnits(swap.spentAmount, swap.srcDecimals) } },
      reserve: { underlyingToken: { address: swap.srcToken } },
    })
    missing.set(at, list)
  }

  if (missing.size === 0) return [...items]

  const out: HistoryItem[] = []
  items.forEach((tx, i) => {
    out.push(tx)
    const extra = missing.get(i)
    if (extra) out.push(...extra)
  })
  return out
}

/**
 * The fill for one asset in one transaction, in dollars — or null when there is nothing to apply.
 *
 * Null covers three cases that all mean the same thing to the caller: this transaction was not one
 * of ours, or it was but the row is missing, or the quote token has no oracle price in it. Each
 * leaves the lot at the indexer's own price, which is where it was before any of this.
 */
function fillUsd(
  fills: SwapFills,
  prices: Record<string, Record<string, number>>,
  /** Every price seen SO FAR, as a fallback. Never a later one — see below. */
  lastSeen: Record<string, number>,
  hash: string | undefined,
  asset: string,
): FillUsd | null {
  if (!hash) return null
  const key = hash.toLowerCase()
  const fill = fills[key]?.[asset]
  if (!fill) return null
  // The transaction's own read first, then the most recent one before it. The fallback is what
  // makes a close work at all: Aave reports only the repay leg of one, so the collateral token it
  // was quoted in is named nowhere in that transaction. Without it, a close fell back to the
  // oracle price of the asset — which on a real Base short booked $2,282.33 of profit against an
  // actual $590. Strictly backwards-looking, because pricing a past trade at a later read is the
  // other way to get this wrong.
  const quoteUsd = prices[key]?.[fill.quote] || lastSeen[fill.quote] || 0
  if (!(quoteUsd > 0)) return null

  // ONE leg per swap, never both.
  //
  // A fill carries a single fact — the ratio between two tokens — and a swap has two legs that
  // can each claim it. Applying it to both books the same trade twice, from opposite sides: on a
  // real Base short, selling 220 WETH for 536,836 USDC gave the WETH leg its true entry AND told
  // the USDC leg those dollars had been bought at $1.0015 apiece. Closing it then sold them at
  // $0.9967. That is the WETH/oracle gap re-expressed as a claim about the dollar, and it booked
  // a $3,684 loss on a stablecoin that never moved.
  //
  // So the fill prices the leg quoted in the STABLER asset, and the other keeps the oracle's read.
  // With both legs volatile — WETH against WBTC — neither does: a ratio cannot become two dollar
  // prices, and choosing which one absorbs the difference would be picking a side at random.
  if (isVolatilePrice(quoteUsd)) return null

  // A DOLLAR TO THE DOLLAR, deliberately — the price above classifies the quote token, it does
  // not scale the fill.
  //
  // Aave reads USD₮0 on Arbitrum at 1.00012415, and multiplying by it turned a fill of 2,447.7557
  // USDT per WETH into $2,448.0596 — a figure that no longer matches the transaction it came
  // from. It also puts the peg's own wobble inside the P&L: an entry scaled by one day's reading
  // and an exit by another manufactures a gain out of a stablecoin that never moved, which is the
  // same error the leg check above exists to prevent.
  //
  // `isVolatilePrice` already bounds this to two percent, and in practice to a hundredth of one.
  // What it buys is a number the user can check against the swap on an explorer.
  return { units: fill.units, usdPerUnit: fill.perUnit }
}

/**
 * Increase basis: user acquires more of an asset (supply for lenders, borrow for borrowers).
 * Weighted-average cost — dilutes the existing avg entry price by the new amount × its execution price.
 */
function addEntry(acc: Accumulator, units: number, usdPerToken: number, fill?: FillUsd | null) {
  if (units <= 0) return

  // A leveraged open supplies two lots at once and they cost different things: what the router
  // bought, at the rate it filled at, and whatever margin the user walked in with, at the oracle
  // price. Aave reports the pair as one supply, so the split happens here or not at all —
  // pricing all of it at either number is wrong by the size of the other lot.
  if (fill) {
    const swapped = Math.min(units, fill.units)
    addEntry(acc, swapped, fill.usdPerUnit)
    addEntry(acc, units - swapped, usdPerToken)
    return
  }

  acc.totalUnits += units
  // An entry the indexer could not price contributes to the principal but not to the average:
  // it goes into `totalUnits` only, leaving `pricedUnits` and the cost untouched so the average
  // stays a true average of the entries we can actually see. See {@link Accumulator}.
  if (usdPerToken > 0) {
    acc.pricedUnits += units
    acc.totalCostUsd += units * usdPerToken
  }
}

/**
 * Decrease basis and realize P&L. `direction`:
 *   'sell'  — lender withdraws or is liquidated: gain = (exitPrice - avgEntry) × units
 *   'cover' — borrower repays or is liquidated:  gain = (avgEntry - exitPrice) × units
 */
function realizeExit(
  acc: Accumulator,
  units: number,
  usdPerToken: number,
  direction: 'sell' | 'cover',
  fill?: FillUsd | null
): number {
  if (units <= 0 || acc.totalUnits <= 0) return 0

  // Same split as `addEntry`, for the same reason: a leveraged close sells part of the withdrawal
  // through a router and hands the rest back untouched. Realizing the whole thing at the oracle
  // price books a gain the trade did not make.
  if (fill) {
    const swapped = Math.min(units, fill.units)
    return (
      realizeExit(acc, swapped, fill.usdPerUnit, direction) +
      realizeExit(acc, units - swapped, usdPerToken, direction)
    )
  }

  const avgEntry = avgEntryOf(acc)
  const consumed = Math.min(units, acc.totalUnits)
  // Returned as well as accumulated, so one exit can be reported against the transaction it
  // happened in. Recent activity shows this per row; the account total is the same figures summed.
  let realized = 0
  if (usdPerToken > 0 && avgEntry > 0) {
    const delta = direction === 'sell' ? usdPerToken - avgEntry : avgEntry - usdPerToken
    realized = consumed * delta
    acc.realizedPnlUsd += realized
  }
  // Scale the priced basis by the share of the position that remains, so the average entry
  // price is unchanged by an exit — which is what weighted-average cost means. Scaling
  // `pricedUnits` and `totalCostUsd` by the same factor is what preserves it.
  const remainingShare = (acc.totalUnits - consumed) / acc.totalUnits
  acc.totalUnits -= consumed
  acc.pricedUnits *= remainingShare
  acc.totalCostUsd *= remainingShare

  // The position is gone, so what it made goes with it. Whatever opens next starts from nothing —
  // which the cost and the average already do, because both were just scaled by zero. The figure
  // is not lost: this function RETURNS it, and the caller books it against the transaction.
  if (acc.totalUnits <= 0) acc.realizedPnlUsd = 0
  return realized
}

export function useAaveHistoricalInterest(userAddress?: string, chainIdOverride?: number) {
  const { address: connectedAddress } = useConnection()
  const connectedChainId = useChainId()
  const chainId = chainIdOverride ?? connectedChainId
  const chainConfig = getChainConfig(chainId)
  const hasAaveConfig = !!chainConfig?.aave

  const targetAddress = userAddress || connectedAddress
  const market = chainConfig?.aave.poolAddress

  const storage = useMemo(() => browserStorage(), [])

  /** Last load's rows, so the profit column has something to show on the first frame. */
  const snapshot = useMemo(
    () => readHistorySnapshot(storage, targetAddress, chainId, market),
    [storage, targetAddress, chainId, market],
  )

  const { data, isLoading, error } = useQuery({
    ...userHistoryQuery(storage, targetAddress, chainId, market),
    enabled: !!targetAddress && hasAaveConfig,
    initialData: snapshot?.items,
    /**
     * Stamped at the epoch, NOT at when the snapshot was written.
     *
     * A seed is a first frame, never an answer, so it has to be stale on arrival or react-query
     * has no reason to go and ask. Handing over the real write time looks more honest and is the
     * bug: `staleTime` is five minutes, so anyone who reloaded within five minutes of their last
     * load would be shown a basis off the disk and no request would be made to check it — and a
     * basis that stale prices a position that may have been closed since.
     *
     * Costing nothing extra is what makes this safe: with no snapshot the query fetches on mount
     * anyway. The only difference is what is on screen while it does. Once the real rows land they
     * carry a real timestamp, and the five minutes applies normally from there.
     */
    initialDataUpdatedAt: 0,
  })

  /**
   * The fills this browser recorded for this wallet, so the ledger below can price the lots a
   * router bought at the rate it bought them, rather than at the block's oracle read.
   *
   * Filtered by wallet, which is what makes it safe while viewing somebody else's address: these
   * rows are this browser's, and a stranger's position has none of them here. Nothing degrades
   * when they are missing — every lot simply keeps the indexer's own price, which is where all of
   * them were before this existed.
   */
  const historyRevision = useSyncExternalStore(subscribeHistory, historyVersion, historyVersion)
  const history = useMemo((): TxHistoryEntry[] => {
    void historyRevision
    if (!targetAddress) return []
    return loadHistory(storage, { wallet: targetAddress as Address, chainId })
  }, [storage, targetAddress, chainId, historyRevision])

  // Replaying the whole transaction history on every render is pure waste: the result is a
  // function of `data` alone, and this hook feeds useAavePositions, which feeds eight
  // components. Without this memo every one of them re-derived cost basis on every render,
  // and the fresh object identities invalidated every downstream useMemo.
  const { netPrincipals, costBasis, realizedByTx } = useMemo(() => {
  const fills: SwapFills = swapFills(history)
  const supplyAcc: Record<string, Accumulator> = {}
  const borrowAcc: Record<string, Accumulator> = {}

  // Aave's own ledger, with the withdrawals it does not report filled in from our rows.
  const items: HistoryItem[] | undefined = data && withCloseWithdrawals(data, history)
  const prices = oraclePricesByTx(items ?? [])
  /** Oracle prices as they go past, so a fill can be converted with a read from BEFORE it. */
  const lastSeen: Record<string, number> = {}
  /**
   * Realized P&L per transaction, so Recent activity can report what each close actually made.
   *
   * A close realizes on BOTH legs — the collateral it sold and the debt it bought back — and both
   * land under the same hash, which is what makes the row's figure the whole trade rather than
   * half of it. An OPEN never appears here: it sets a basis, it does not settle one.
   */
  const realizedByTx: Record<string, number> = {}
  const bookRealized = (hash: string | undefined, usd: number) => {
    if (!hash || usd === 0) return
    const key = hash.toLowerCase()
    realizedByTx[key] = (realizedByTx[key] ?? 0) + usd
  }
  if (items) {
    for (const tx of items) {
      notePrices(tx, lastSeen)
      switch (tx.__typename) {
        case 'UserSupplyTransaction': {
          const asset = tx.reserve?.underlyingToken.address.toLowerCase()
          if (!asset || !tx.amount) break
          const acc = (supplyAcc[asset] ??= newAcc())
          addEntry(
            acc,
            Number(tx.amount.amount.value),
            Number(tx.amount.usdPerToken || 0),
            fillUsd(fills, prices, lastSeen, tx.txHash, asset),
          )
          break
        }
        case 'UserWithdrawTransaction': {
          const asset = tx.reserve?.underlyingToken.address.toLowerCase()
          if (!asset || !tx.amount) break
          const acc = (supplyAcc[asset] ??= newAcc())
          bookRealized(tx.txHash, realizeExit(
            acc,
            Number(tx.amount.amount.value),
            Number(tx.amount.usdPerToken || 0),
            'sell',
            fillUsd(fills, prices, lastSeen, tx.txHash, asset),
          ))
          break
        }
        case 'UserBorrowTransaction': {
          const asset = tx.reserve?.underlyingToken.address.toLowerCase()
          if (!asset || !tx.amount) break
          const acc = (borrowAcc[asset] ??= newAcc())
          addEntry(
            acc,
            Number(tx.amount.amount.value),
            Number(tx.amount.usdPerToken || 0),
            fillUsd(fills, prices, lastSeen, tx.txHash, asset),
          )
          break
        }
        case 'UserRepayTransaction': {
          const asset = tx.reserve?.underlyingToken.address.toLowerCase()
          if (!asset || !tx.amount) break
          const acc = (borrowAcc[asset] ??= newAcc())
          bookRealized(tx.txHash, realizeExit(
            acc,
            Number(tx.amount.amount.value),
            Number(tx.amount.usdPerToken || 0),
            'cover',
            fillUsd(fills, prices, lastSeen, tx.txHash, asset),
          ))
          break
        }
        case 'UserLiquidationCallTransaction': {
          if (tx.collateral?.amount) {
            const asset = tx.collateral.reserve.underlyingToken.address.toLowerCase()
            const acc = (supplyAcc[asset] ??= newAcc())
            realizeExit(
              acc,
              Number(tx.collateral.amount.amount.value),
              Number(tx.collateral.amount.usdPerToken || 0),
              'sell'
            )
          }
          if (tx.debtRepaid?.amount) {
            const asset = tx.debtRepaid.reserve.underlyingToken.address.toLowerCase()
            const acc = (borrowAcc[asset] ??= newAcc())
            realizeExit(
              acc,
              Number(tx.debtRepaid.amount.amount.value),
              Number(tx.debtRepaid.amount.usdPerToken || 0),
              'cover'
            )
          }
          break
        }
      }
    }
  }

  const netPrincipals = {
    supply: {} as Record<string, number>,
    borrow: {} as Record<string, number>
  }
  const costBasis = {
    supply: {} as Record<string, CostBasis>,
    borrow: {} as Record<string, CostBasis>
  }

  for (const [asset, acc] of Object.entries(supplyAcc)) {
    netPrincipals.supply[asset] = acc.totalUnits
    costBasis.supply[asset] = {
      avgEntryPriceUsd: avgEntryOf(acc),
      realizedPnlUsd: acc.realizedPnlUsd
    }
  }
  for (const [asset, acc] of Object.entries(borrowAcc)) {
    netPrincipals.borrow[asset] = acc.totalUnits
    // Reported, not zeroed. Buying a debt back below what it was sold for IS profit, and it is
    // the ONLY profit a short ever makes — zeroing it here left every closed short reading as
    // nothing happened. The supply side has always reported its own; the two now agree.
    costBasis.borrow[asset] = {
      avgEntryPriceUsd: avgEntryOf(acc),
      realizedPnlUsd: acc.realizedPnlUsd
    }
  }

  return { netPrincipals, costBasis, realizedByTx }
  }, [data, history])

  return {
    netPrincipals,
    costBasis,
    /** Realized USD P&L keyed by LOWER-CASED transaction hash. Closes only; opens settle nothing. */
    realizedByTx,
    isLoadingHistory: isLoading,
    errorHistory: error
  }
}
