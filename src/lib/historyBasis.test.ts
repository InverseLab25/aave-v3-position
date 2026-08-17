import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { avgEntryFromHistory } from './historyBasis'
import type { TxHistoryEntry } from './txHistory'

const WALLET = '0x1111111111111111111111111111111111111111' as Address
const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' as Address
const USDT = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' as Address
const WBTC = '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f' as Address

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex

/** $1.00 for the stables, a real price for anything else. */
const prices = (token: Address): number | undefined => {
  const at: Record<string, number> = {
    [USDT.toLowerCase()]: 1,
    [WBTC.toLowerCase()]: 95_000,
    [WETH.toLowerCase()]: 1_900,
  }
  return at[token.toLowerCase()]
}

const weth = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6)) * 10n ** 12n
const usd = (n: number) => BigInt(n) * 10n ** 6n

/** An open that bought `returnAmount` of `dstToken` for `spentAmount` of `srcToken`. */
function open(over: {
  hash?: Hex
  at?: number
  srcToken?: Address
  srcDecimals?: number | null
  dstToken?: Address
  dstDecimals?: number | null
  spentAmount?: bigint
  returnAmount?: bigint
  kind?: 'open' | 'close'
} = {}): TxHistoryEntry {
  return {
    hash: over.hash ?? hash(1),
    chainId: 42161,
    wallet: WALLET,
    kind: over.kind ?? 'open',
    at: over.at ?? 1_800_000_000_000,
    swap: {
      srcToken: over.srcToken ?? USDT,
      dstToken: over.dstToken ?? WETH,
      srcSymbol: 'USDT',
      srcDecimals: over.srcDecimals === undefined ? 6 : over.srcDecimals,
      dstSymbol: 'WETH',
      dstDecimals: over.dstDecimals === undefined ? 18 : over.dstDecimals,
      spentAmount: over.spentAmount ?? 67_754_406_950n,
      returnAmount: over.returnAmount ?? 36_112_335_215_858_211_266n,
    },
    rate: null,
    fill: null,
    deltas: [],
    source: 'chain',
    blockNumber: 100n,
  }
}

describe('avgEntryFromHistory', () => {
  it('prices a single open at what the swap actually filled at', () => {
    // Arbitrum 0x4ed0dd94…: 67,754.40695 USDT for 36.112335215858211266 WETH.
    const avg = avgEntryFromHistory([open()], WETH, prices)

    expect(avg).toBeCloseTo(1876.2122843899, 6)
  })

  it('weights two opens by size rather than taking a plain mean', () => {
    // 10 WETH at $1,800 and 1 WETH at $2,000 is a $1,818.18 basis, not $1,900.
    const avg = avgEntryFromHistory(
      [
        open({ hash: hash(1), spentAmount: 18_000_000_000n, returnAmount: 10n * 10n ** 18n }),
        open({ hash: hash(2), spentAmount: 2_000_000_000n, returnAmount: 10n ** 18n }),
      ],
      WETH,
      prices,
    )

    expect(avg).toBeCloseTo(1818.1818, 4)
  })

  it('skips an open whose debt token has no honest USD value', () => {
    // WBTC-denominated debt: the fill rate is WBTC per WETH, and calling that a dollar price
    // would re-price the basis every time BTC moves.
    const avg = avgEntryFromHistory([open({ srcToken: WBTC, srcDecimals: 8 })], WETH, prices)

    expect(avg).toBeNull()
  })

  it('has nothing to price from a close with no open before it', () => {
    const avg = avgEntryFromHistory([open({ kind: 'close' })], WETH, prices)

    expect(avg).toBeNull()
  })

  /** A close sells the collateral, so its legs run the other way round from an open's. */
  const close = (o: { hash: Hex; at: number; soldWeth: string }) =>
    open({
      hash: o.hash,
      at: o.at,
      kind: 'close',
      srcToken: WETH,
      srcDecimals: 18,
      dstToken: USDT,
      dstDecimals: 6,
      spentAmount: weth(o.soldWeth),
      returnAmount: usd(1),
    })

  const buy = (o: { hash: Hex; at: number; units: string; price: number }) =>
    open({
      hash: o.hash,
      at: o.at,
      returnAmount: weth(o.units),
      spentAmount: usd(Math.round(parseFloat(o.units) * o.price)),
    })

  it('starts a fresh basis after a full close', () => {
    // open, open, close, open — the sequence that matters. The first two are GONE once the
    // position is fully closed, so their cost must not follow the new one around.
    const avg = avgEntryFromHistory(
      [
        buy({ hash: hash(1), at: 1_000, units: '10', price: 1800 }),
        buy({ hash: hash(2), at: 2_000, units: '1', price: 2000 }),
        close({ hash: hash(3), at: 3_000, soldWeth: '11' }),
        buy({ hash: hash(4), at: 4_000, units: '2', price: 3000 }),
      ],
      WETH,
      prices,
    )

    expect(avg).toBeCloseTo(3000, 6)
  })

  it('leaves the average alone when a close is only partial', () => {
    // Sell 5 of 10 bought at 1,800 and the 5 still held cost 1,800 each. That is what a
    // weighted-average cost means, and it is why a partial close must NOT reset anything.
    const avg = avgEntryFromHistory(
      [
        buy({ hash: hash(1), at: 1_000, units: '10', price: 1800 }),
        close({ hash: hash(2), at: 2_000, soldWeth: '5' }),
      ],
      WETH,
      prices,
    )

    expect(avg).toBeCloseTo(1800, 6)
  })

  it('replays in time order however the rows arrive', () => {
    // `loadHistory` hands back newest-first, so a function that trusted its caller's order would
    // process the close before the opens it settles and reset nothing.
    const avg = avgEntryFromHistory(
      [
        buy({ hash: hash(4), at: 4_000, units: '2', price: 3000 }),
        close({ hash: hash(3), at: 3_000, soldWeth: '11' }),
        buy({ hash: hash(2), at: 2_000, units: '1', price: 2000 }),
        buy({ hash: hash(1), at: 1_000, units: '10', price: 1800 }),
      ],
      WETH,
      prices,
    )

    expect(avg).toBeCloseTo(3000, 6)
  })

  it('resets when a close sells more than the fills bought', () => {
    // Collateral accrues interest, so exiting sells more than was ever bought. That is still a
    // full exit, and flooring the ledger at zero is what makes it read as one.
    const avg = avgEntryFromHistory(
      [
        buy({ hash: hash(1), at: 1_000, units: '10', price: 1800 }),
        close({ hash: hash(2), at: 2_000, soldWeth: '10.5' }),
        buy({ hash: hash(3), at: 3_000, units: '1', price: 3000 }),
      ],
      WETH,
      prices,
    )

    expect(avg).toBeCloseTo(3000, 6)
  })

  it('ignores an open that bought a different collateral', () => {
    const avg = avgEntryFromHistory([open()], WBTC, prices)

    expect(avg).toBeNull()
  })

  it('ignores an open whose decimals were never recorded', () => {
    const avg = avgEntryFromHistory([open({ dstDecimals: null })], WETH, prices)

    expect(avg).toBeNull()
  })

  it('has nothing to say about an empty history', () => {
    expect(avgEntryFromHistory([], WETH, prices)).toBeNull()
  })

  it('values the debt in dollars rather than assuming a stable is exactly $1', () => {
    // A stable trading at $0.99 bought fewer dollars of WETH than its face value suggests.
    const avg = avgEntryFromHistory([open()], WETH, (t) =>
      t.toLowerCase() === USDT.toLowerCase() ? 0.99 : prices(t),
    )

    expect(avg).toBeCloseTo(1876.2122843899 * 0.99, 6)
  })
})
