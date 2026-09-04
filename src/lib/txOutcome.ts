/**
 * What a transaction actually did, read back off its own receipt.
 *
 * The panel's numbers are all forecasts — a quote's `amountOut`, a projected health factor, a
 * `minOut` floor. None of them is what happened. The receipt is, and it is already in hand by the
 * time the flow reports success, so the settled figures cost nothing but the decoding.
 */
import { decodeEventLog, type Address, type Hex } from 'viem'
import type { OutBasis } from './deleverage'

/**
 * `keccak256("Swapped(address,address,address,address,uint256,uint256)")`.
 *
 * Shared by the 1inch aggregation router and KyberSwap's MetaAggregationRouter — the signature is
 * identical, so one topic covers both.
 */
export const SWAPPED_TOPIC = '0xd6d4f5681c246c9f42c203e287975af1601f8df8035a9251f79aab5c8f09e2f8' as const

const swappedAbi = [
  {
    type: 'event',
    name: 'Swapped',
    inputs: [
      { name: 'sender', type: 'address', indexed: false },
      { name: 'srcToken', type: 'address', indexed: false },
      { name: 'dstToken', type: 'address', indexed: false },
      { name: 'dstReceiver', type: 'address', indexed: false },
      { name: 'spentAmount', type: 'uint256', indexed: false },
      { name: 'returnAmount', type: 'uint256', indexed: false },
    ],
  },
] as const

/**
 * `keccak256("AggregatedTrade(uint16,address,address,address,address,uint256,uint256,uint256)")`.
 *
 * Nordstern's Guard emits this instead of `Swapped`. Confirmed against a real Base close, tx
 * 0x8849dbd2…c819d: same topic, and the words land where this ABI says they do.
 */
export const AGGREGATED_TRADE_TOPIC =
  '0x97d8fe5395a5423bef64e2004851e9b3f60f7848835afa581b4a0a8e84bc662d' as const

const aggregatedTradeAbi = [
  {
    type: 'event',
    name: 'AggregatedTrade',
    inputs: [
      { name: 'id', type: 'uint16', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'tokenIn', type: 'address', indexed: false },
      { name: 'tokenOut', type: 'address', indexed: false },
      { name: 'executor', type: 'address', indexed: false },
      { name: 'amountIn', type: 'uint256', indexed: false },
      { name: 'amountOut', type: 'uint256', indexed: false },
      { name: 'minAmountOut', type: 'uint256', indexed: false },
    ],
  },
] as const

/** `keccak256("Transfer(address,address,uint256)")` — every ERC20 movement carries it. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const transferAbi = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const

/** The fields of a receipt log the decoders read. Structural, so a viem receipt log fits as-is. */
export interface ReceiptLog {
  address: Address
  topics: readonly Hex[]
  data: Hex
}

/** One filled swap, as the router reported it. */
interface RouterSwap {
  /** The contract that emitted it — the router itself. */
  router: Address
  sender: Address
  srcToken: Address
  dstToken: Address
  dstReceiver: Address
  spentAmount: bigint
  returnAmount: bigint
}

/**
 * Every router fill in a receipt, in the order the transaction emitted them.
 *
 * Two event shapes, because the aggregators the contracts can execute do not agree on one.
 * KyberSwap and 1inch emit `Swapped`; Nordstern's Guard emits `AggregatedTrade`. Reading only
 * the first left every Nordstern close reporting nothing at all — no settled fill, no history
 * basis, no fill price — which is worse than reporting it wrong, because nothing looks broken.
 *
 * `AggregatedTrade` names no receiver. The Guard pulls with `transferFrom(msg.sender, …)` and
 * returns the output to that same caller, so `user` is both sender and receiver.
 *
 * A receipt carries every log the whole call tree produced — Aave's, the flash lender's, the
 * tokens' — so anything that fails to decode is skipped rather than thrown on. A report that
 * omits a swap is a smaller failure than one that unmounts the modal it was meant to appear in.
 */
export function decodeSwaps(logs: readonly ReceiptLog[]): RouterSwap[] {
  const swaps: RouterSwap[] = []
  for (const log of logs) {
    try {
      if (log.topics[0] === SWAPPED_TOPIC) {
        const { args } = decodeEventLog({
          abi: swappedAbi,
          eventName: 'Swapped',
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
        })
        swaps.push({ router: log.address, ...args })
      } else if (log.topics[0] === AGGREGATED_TRADE_TOPIC) {
        const { args } = decodeEventLog({
          abi: aggregatedTradeAbi,
          eventName: 'AggregatedTrade',
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
        })
        swaps.push({
          router: log.address,
          sender: args.user,
          srcToken: args.tokenIn,
          dstToken: args.tokenOut,
          dstReceiver: args.user,
          spentAmount: args.amountIn,
          returnAmount: args.amountOut,
        })
      }
    } catch {
      // Truncated data, or a variant that indexes its address arguments — either way the words
      // are not where this ABI says they are, and guessing produces numbers worse than silence.
      continue
    }
  }
  return swaps
}

/** What one token did to a wallet's balance across a transaction. Negative means it left. */
export interface WalletDelta {
  token: Address
  delta: bigint
}

/**
 * What the transaction moved in and out of `wallet`, netted per token.
 *
 * Read from the receipt rather than from balances taken either side of the send: a snapshot pair
 * races anything else the wallet is doing, and needs its list of tokens decided in advance — which
 * is exactly what cannot be known before the fact.
 *
 * Reports every token, including Aave's aToken and variable-debt token, which arrive here because
 * Aave mints and burns them as transfers from and to the zero address. Deciding which of those a
 * user should SEE is the caller's job — see {@link hideTokens}.
 */
export function walletDeltas(logs: readonly ReceiptLog[], wallet: Address): WalletDelta[] {
  const owner = wallet.toLowerCase()
  // Keyed by lower-cased address so one token cannot split across two rows on casing alone; the
  // value keeps the address as the log wrote it, which is what the caller looks metadata up with.
  const netted = new Map<string, WalletDelta>()

  for (const log of logs) {
    if (log.topics[0] !== TRANSFER_TOPIC) continue
    let from: string
    let to: string
    let value: bigint
    try {
      const { args } = decodeEventLog({
        abi: transferAbi,
        eventName: 'Transfer',
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      })
      from = args.from.toLowerCase()
      to = args.to.toLowerCase()
      value = args.value
    } catch {
      // An ERC721 `Transfer` shares this topic but indexes its token id, so it decodes here as a
      // topic-count mismatch. Letting it through would report an id as an amount.
      continue
    }

    const moved = (to === owner ? value : 0n) - (from === owner ? value : 0n)
    if (moved === 0n) continue

    const key = log.address.toLowerCase()
    const seen = netted.get(key)
    if (seen) seen.delta += moved
    else netted.set(key, { token: log.address, delta: moved })
  }

  // A token that ended where it started is not a change, however many times it moved on the way.
  return [...netted.values()].filter((d) => d.delta !== 0n)
}

/**
 * The fill read off plain `Transfer` logs, for routers that announce nothing.
 *
 * Socket and the 0x Settler underneath it emit no swap event at all, so `decodeSwaps` comes back
 * empty and the whole report — settled fill, fill quality, history basis — silently goes missing.
 * The transfers are still there, and two of them say exactly what happened: the first `srcToken`
 * to leave the executor is what it paid, and the last `dstToken` to arrive is what it got.
 *
 * Read from the END for the output, which is what keeps the flash loan out of it. A leveraged
 * open receives its loan in the SAME token the swap pays out — on Base, 10 WETH arriving before
 * the swap is even asked for — so a scan that starts at the top finds the loan and reports
 * 10 WETH of output that no swap produced. From the bottom, the loan is never reached.
 *
 * Null when either leg is missing, which is the honest answer for a receipt that holds no swap.
 */
export function swapFromTransfers(
  logs: readonly ReceiptLog[],
  executor: Address,
  pair: { srcToken: Address; dstToken: Address },
): RouterSwap | null {
  const who = executor.toLowerCase()
  // topics[1] is `from` and topics[2] is `to`, both addresses left-padded to 32 bytes.
  const at = (log: ReceiptLog, i: 1 | 2) => ('0x' + (log.topics[i] ?? '').slice(-40)).toLowerCase()
  const isTransfer = (log: ReceiptLog, token: Address, party: 1 | 2) =>
    log.topics[0] === TRANSFER_TOPIC &&
    log.topics.length >= 3 &&
    log.address.toLowerCase() === token.toLowerCase() &&
    at(log, party) === who

  const sent = logs.find((l) => isTransfer(l, pair.srcToken, 1))
  const received = logs.findLast((l) => isTransfer(l, pair.dstToken, 2))
  if (!sent || !received) return null

  return {
    router: executor,
    sender: executor,
    srcToken: pair.srcToken,
    dstToken: pair.dstToken,
    dstReceiver: executor,
    spentAmount: BigInt(sent.data),
    returnAmount: BigInt(received.data),
  }
}

/**
 * The swap this flow was quoting, out of everything the receipt reported.
 *
 * A leveraged open or close fills through exactly one router call, but the receipt also carries
 * whatever else the route touched on the way — so the pair is matched rather than assumed. Falling
 * back to the first keeps a report on screen when a router splits the fill differently than the
 * quote described.
 */
export function pickSwap(
  swaps: readonly RouterSwap[],
  pair: { srcToken: Address; dstToken: Address },
): RouterSwap | null {
  if (swaps.length === 0) return null
  const src = pair.srcToken.toLowerCase()
  const dst = pair.dstToken.toLowerCase()
  const matched = swaps.find(
    (s) => s.srcToken.toLowerCase() === src && s.dstToken.toLowerCase() === dst,
  )
  return matched ?? swaps[0]
}

/** How the settled fill compares with the route that was signed off. */
interface FillQuality {
  /** Received less quoted. Negative is the ordinary case: the price moved while it was in flight. */
  delta: bigint
  /** `delta` as a percentage of the quote. Null when there was no quote to measure against. */
  percent: number | null
  /**
   * The fill came in under `minOut`. Should be impossible — the contract reverts on it
   * (AaveV3Strategies.sol:499) — so seeing it means the floor was not the one that was enforced,
   * which is worth showing rather than swallowing.
   */
  belowFloor: boolean
  /**
   * Whose word `expectedOut` was on, so `delta` can be read for what it is.
   *
   * A delta against a SIMULATED expectation is drift between a measurement and the chain, and is
   * normally thousandths of a percent. A delta against a QUOTED one is the gap between an
   * aggregator's arithmetic and reality, which is a different and much weaker claim. Both print
   * as a percentage, so without this they average together into a number meaning neither.
   */
  basis: OutBasis
}

/** Percentages are reported to four decimals, which is finer than any tolerance a user sets. */
const PERCENT_SCALE = 1_000_000n

export function fillQuality(o: {
  returnAmount: bigint
  expectedOut: bigint
  minOut: bigint
  basis: OutBasis
}): FillQuality {
  const delta = o.returnAmount - o.expectedOut
  return {
    delta,
    percent:
      o.expectedOut === 0n ? null : Number((delta * PERCENT_SCALE) / o.expectedOut) / 10_000,
    belowFloor: o.returnAmount < o.minOut,
    basis: o.basis,
  }
}

/** Everything a flow can say about its own transaction once the receipt is in. */
export interface TxOutcome {
  /** The router fill, or null when the receipt carried no `Swapped` — a revert, or a foreign tx. */
  swap: RouterSwap | null
  /** How that fill compared with the quote. Null exactly when `swap` is. */
  fill: FillQuality | null
  deltas: WalletDelta[]
}

/**
 * The whole reading, from one receipt. Null when the receipt has nothing to say about this wallet.
 *
 * The wallet changes are reported whether or not a swap was found: a receipt with no `Swapped` in
 * it still moved collateral and debt, and those rows are the ones a user checks first. Only when
 * BOTH are empty is there no report — and that is a different thing from an empty one, which
 * reads as a failed read rather than as a quiet transaction.
 */
export function readOutcome(o: {
  logs: readonly ReceiptLog[]
  wallet: Address
  /**
   * Whoever held the tokens during the swap, when that is not the wallet.
   *
   * A leveraged open or close swaps inside AaveV3Strategies, so the transfers that describe the
   * fill are the contract's and not the user's. Defaults to `wallet`, which is right for the
   * plain swap where the signer is the one trading.
   */
  executor?: Address
  pair: { srcToken: Address; dstToken: Address }
  expectedOut: bigint
  minOut: bigint
  /** Whose word `expectedOut` is on. Defaults to `quoted`, the weakest reading. */
  basis?: OutBasis
}): TxOutcome | null {
  const swap =
    pickSwap(decodeSwaps(o.logs), o.pair) ??
    swapFromTransfers(o.logs, o.executor ?? o.wallet, o.pair)
  const deltas = walletDeltas(o.logs, o.wallet)
  if (!swap && deltas.length === 0) return null
  return {
    swap,
    fill: swap
      ? fillQuality({
          returnAmount: swap.returnAmount,
          expectedOut: o.expectedOut,
          minOut: o.minOut,
          basis: o.basis ?? 'quoted',
        })
      : null,
    deltas,
  }
}

/**
 * The same outcome with certain tokens left out of its wallet rows.
 *
 * Used to drop the aToken and the variable-debt token: Aave mints and burns both to the user, so
 * they net into the deltas and describe the POSITION rather than the wallet — which the projection
 * already covers, in units the underlying says better. The swap and the fill are untouched, and
 * an outcome left with neither a swap nor a row has nothing to report.
 */
export function hideTokens(
  outcome: TxOutcome | null,
  hidden: readonly Address[],
): TxOutcome | null {
  if (!outcome) return null
  const skip = new Set(hidden.map((t) => t.toLowerCase()))
  const deltas = outcome.deltas.filter((d) => !skip.has(d.token.toLowerCase()))
  if (!outcome.swap && deltas.length === 0) return null
  return { ...outcome, deltas }
}
