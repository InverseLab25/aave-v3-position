/**
 * A position event, turned back into the history row the flow that sent it would have written.
 *
 * The event alone says a position was opened or closed. What it cost is in the receipt, which is
 * still on chain long after the modal that could have reported it has gone — so the same decoders
 * the live path uses are pointed at a receipt fetched by hash instead of one handed over by
 * `waitForTransactionReceipt`.
 *
 * One thing is unrecoverable. `fill` compares the settled amount against `expectedOut` and
 * `minOut`, and both came from a quote that exists nowhere on chain. A recovered row therefore has
 * a rate but no fill quality, permanently, and inventing one would be worse than the gap.
 */
import type { Address, Hex } from 'viem'
import { quoteRate } from './deleverage'
import type { PositionEvent } from './strategiesLogs'
import type { TokenMeta } from './tokenMeta'
import { decodeSwaps, pickSwap, walletDeltas, type ReceiptLog } from './txOutcome'
import type { HistoryDelta, TxHistoryEntry } from './txHistory'

/**
 * How many receipt reads are allowed to be in flight together.
 *
 * A first scan of a busy wallet can turn up hundreds of transactions, and asking for every receipt
 * at once produces either one enormous batched POST — past the batch size most providers accept —
 * or hundreds of parallel requests, which is what rate limiting exists to stop. Twenty keeps the
 * scan quick without ever looking like an attack.
 */
export const RECEIPT_CONCURRENCY = 20

/** `mapper` over `items`, at most `limit` at a time, results in the original order. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0

  // Each worker pulls the next index until there are none left, so one slow request delays only
  // itself rather than a whole fixed-size batch.
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await mapper(items[i])
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export interface PositionReceipt {
  logs: readonly ReceiptLog[]
  status: 'success' | 'reverted'
}

/** Structural, so the rules below are testable against a plain object rather than a transport. */
export interface ReceiptClient {
  getTransactionReceipt(args: { hash: Hex }): Promise<PositionReceipt>
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>
}

export interface BackfillContext {
  wallet: Address
  chainId: number
  /** Symbol and decimals per token, keyed by LOWER-CASED address. */
  tokens: Record<string, TokenMeta>
  /** The aToken and variable-debt addresses to leave out of the wallet rows. */
  hidden: readonly Address[]
}

/**
 * Which way the swap ran, from the event's own indexed arguments.
 *
 * An open borrows the debt asset and sells it for collateral (`_swap(debtAsset, …)`,
 * AaveV3Strategies.sol:495); a close withdraws collateral and sells it to buy the debt back
 * (`_swap(collateral, …)`, AaveV3Strategies.sol:576). Knowing this before the receipt is read is
 * strictly better than the live path manages — `pickSwap` gets an exact pair to match rather than
 * falling back to whichever `Swapped` happened to come first.
 */
function swapPair(event: PositionEvent): { srcToken: Address; dstToken: Address } {
  return event.kind === 'open'
    ? { srcToken: event.debtAsset, dstToken: event.collateral }
    : { srcToken: event.collateral, dstToken: event.debtAsset }
}

function buildEntry(
  event: PositionEvent,
  receipt: PositionReceipt,
  timestamp: bigint,
  { wallet, chainId, tokens, hidden }: BackfillContext,
): TxHistoryEntry | null {
  // A position event cannot be emitted by a transaction that reverted, so this is a guard against
  // a provider answering with someone else's receipt rather than an expected case.
  if (receipt.status !== 'success') return null

  const meta = (token: Address) => tokens[token.toLowerCase()]
  const swap = pickSwap(decodeSwaps(receipt.logs), swapPair(event))
  const src = swap ? meta(swap.srcToken) : undefined
  const dst = swap ? meta(swap.dstToken) : undefined
  const skip = new Set(hidden.map((t) => t.toLowerCase()))

  return {
    hash: event.hash,
    chainId,
    wallet,
    kind: event.kind,
    // Seconds on chain, milliseconds everywhere in the app.
    at: Number(timestamp * 1000n),
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
    rate: swap && src && dst ? quoteRate(swap.returnAmount, swap.spentAmount, src.decimals, dst.decimals) : null,
    // Not recoverable. See the note at the top of this file.
    fill: null,
    deltas: walletDeltas(receipt.logs, wallet)
      .filter((d) => !skip.has(d.token.toLowerCase()))
      .map((d): HistoryDelta => {
        const m = meta(d.token)
        return { token: d.token, symbol: m?.symbol ?? null, decimals: m?.decimals ?? null, delta: d.delta }
      }),
    source: 'chain',
    blockNumber: event.blockNumber,
  }
}

/**
 * History rows for every event given, built from their receipts.
 *
 * THROWS RATHER THAN SKIPPING A ROW IT COULD NOT BUILD. The result feeds `mergeHistory`, which
 * deletes rows a completed scan did not confirm — so an event quietly dropped here because its
 * receipt would not load is a row deleted from storage on the strength of a network error.
 *
 * The one legitimate omission is a receipt the chain reports as reverted, which is a statement
 * about the transaction rather than about the request.
 */
export async function entriesFromEvents(
  client: ReceiptClient,
  events: readonly PositionEvent[],
  context: BackfillContext,
): Promise<TxHistoryEntry[]> {
  if (events.length === 0) return []

  const receipts = await mapWithLimit(events, RECEIPT_CONCURRENCY, (event) =>
    client.getTransactionReceipt({ hash: event.hash }),
  )

  return entriesFromReceipts(
    client,
    events.map((event, i) => ({ event, receipt: receipts[i] })),
    context,
  )
}

/**
 * The same rows, from receipts the caller ALREADY HAS.
 *
 * Discovery through the indexer reads every candidate receipt to find out which were ours at all
 * — see `receiptScreen` — so by the time the matches are known their receipts are in hand. Going
 * back to the chain for them would double the request count of the cheaper path and undo the
 * reason for taking it.
 */
export async function entriesFromReceipts(
  client: Pick<ReceiptClient, 'getBlock'>,
  found: readonly { event: PositionEvent; receipt: PositionReceipt }[],
  context: BackfillContext,
): Promise<TxHistoryEntry[]> {
  if (found.length === 0) return []

  // Several events can share a block, and a block's timestamp is the same for all of them. Asking
  // once per event would multiply the request count for no extra information.
  const blocks = [...new Set(found.map((f) => f.event.blockNumber))]
  const timestamps = new Map(
    await mapWithLimit(blocks, RECEIPT_CONCURRENCY, async (blockNumber): Promise<[bigint, bigint]> => {
      const { timestamp } = await client.getBlock({ blockNumber })
      return [blockNumber, timestamp]
    }),
  )

  return found
    .map(({ event, receipt }) =>
      buildEntry(event, receipt, timestamps.get(event.blockNumber) ?? 0n, context),
    )
    .filter((entry): entry is TxHistoryEntry => entry !== null)
}

/** One event's row, for the live watcher — which learns about transactions one at a time. */
export async function entryFromEvent(
  client: ReceiptClient,
  event: PositionEvent,
  context: BackfillContext,
): Promise<TxHistoryEntry | null> {
  const [entry] = await entriesFromEvents(client, [event], context)
  return entry ?? null
}
