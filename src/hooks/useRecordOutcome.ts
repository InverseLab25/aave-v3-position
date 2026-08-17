/**
 * Files a settled transaction in the local history, once.
 *
 * Lives here rather than in the flow hooks because this is the layer that knows how to NAME what
 * moved: `useLeverageOpen` and `useDeleverageClose` hold addresses, while the screens around them
 * hold the symbols and decimals. An entry written without those is unreadable a week later, which
 * is the only time anyone opens it.
 */
import { useEffect, useRef } from 'react'
import type { Address, Hex } from 'viem'
import type { TokenMeta } from '../components/TxOutcome'
import { quoteRate } from '../lib/deleverage'
import { appendHistory, type HistoryDelta, type TxHistoryEntry } from '../lib/txHistory'
import { browserStorage } from '../lib/delegationCache'
import type { TxOutcome } from '../lib/txOutcome'

interface RecordOutcomeInput {
  outcome: TxOutcome | null
  /** Symbol and decimals per token, keyed by LOWER-CASED address. */
  tokens: Record<string, TokenMeta>
  hash: Hex | undefined
  chainId: number
  wallet: Address | undefined
  kind: 'open' | 'close'
}

export function useRecordOutcome({ outcome, tokens, hash, chainId, wallet, kind }: RecordOutcomeInput): void {
  /**
   * What has already been filed this mount.
   *
   * `appendHistory` de-duplicates too, but it does so by reading and rewriting the whole list —
   * work worth skipping on every render of a modal that stays open after its transaction lands.
   */
  const filed = useRef<string | null>(null)

  useEffect(() => {
    if (!outcome || !hash || !wallet) return
    const key = `${chainId}:${hash.toLowerCase()}`
    if (filed.current === key) return
    filed.current = key

    const meta = (token: Address) => tokens[token.toLowerCase()]
    const swap = outcome.swap
    const src = swap ? meta(swap.srcToken) : undefined
    const dst = swap ? meta(swap.dstToken) : undefined

    const entry: TxHistoryEntry = {
      hash,
      chainId,
      wallet,
      kind,
      at: Date.now(),
      swap: swap
        ? {
            srcToken: swap.srcToken,
            dstToken: swap.dstToken,
            srcSymbol: src?.symbol ?? null,
            srcDecimals: src?.decimals ?? null,
            dstSymbol: dst?.symbol ?? null,
            dstDecimals: dst?.decimals ?? null,
            spentAmount: swap.spentAmount,
            returnAmount: swap.returnAmount,
          }
        : null,
      // Destination per 1 source, from the SWAP event — the price paid, not the one quoted. Needs
      // both sides' decimals; without them there are two integers and no rate between them.
      rate:
        swap && src && dst
          ? quoteRate(swap.returnAmount, swap.spentAmount, src.decimals, dst.decimals)
          : null,
      fill: outcome.fill,
      deltas: outcome.deltas.map((d): HistoryDelta => {
        const m = meta(d.token)
        return { token: d.token, symbol: m?.symbol ?? null, decimals: m?.decimals ?? null, delta: d.delta }
      }),
      source: 'live',
      // Not known here: this runs off a receipt the flow already has, and the block it landed in
      // is not what the flow was waiting for. The sync fills it in when it confirms the row,
      // which is also the point at which the row becomes safe to prune.
      blockNumber: null,
    }

    appendHistory(browserStorage(), entry)
    // `tokens` is rebuilt per render by its owners, so keying on it would re-run this on every
    // render. What identifies a transaction is its hash, and that is what the guard above uses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome, hash, chainId, wallet, kind])
}
