import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { avgEntryFromHistory } from './historyBasis'
import type { TxHistoryEntry } from './txHistory'

const WALLET = '0x1111111111111111111111111111111111111111' as Address
const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' as Address
const USDT = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' as Address
const WBTC = '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f' as Address

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex

const weth = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6)) * 10n ** 12n
const usdt = (n: number) => BigInt(Math.round(n * 1e6))
const wbtc = (n: number) => BigInt(Math.round(n * 1e8))

function entry(over: {
  hash?: Hex
  at?: number
  kind?: 'open' | 'close'
  srcToken?: Address
  srcDecimals?: number | null
  dstToken?: Address
  dstDecimals?: number | null
  spentAmount?: bigint
  returnAmount?: bigint
}): TxHistoryEntry {
  return {
    hash: over.hash ?? hash(1),
    chainId: 42161,
    wallet: WALLET,
    kind: over.kind ?? 'open',
    at: over.at ?? 1_000,
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

/** An open that bought `units` of WETH at `price` debt tokens each. */
const buy = (o: { hash: Hex; at: number; units: string; price: number }) =>
  entry({
    hash: o.hash,
    at: o.at,
    returnAmount: weth(o.units),
    spentAmount: usdt(parseFloat(o.units) * o.price),
  })

/** A close sells the collateral, so its legs run the other way round from an open's. */
const sell = (o: { hash: Hex; at: number; units: string }) =>
  entry({
    hash: o.hash,
    at: o.at,
    kind: 'close',
    srcToken: WETH,
    srcDecimals: 18,
    dstToken: USDT,
    dstDecimals: 6,
    spentAmount: weth(o.units),
    returnAmount: usdt(1),
  })

describe('avgEntryFromHistory', () => {
  it('prices a single open in the token that paid for it', () => {
    // Arbitrum 0x4ed0dd94…: 67,754.40695 USDT for 36.112335215858211266 WETH. No USD anywhere —
    // the cost is counted in the token that actually left the wallet.
    const basis = avgEntryFromHistory([entry({})], WETH, 'supply')

    expect(basis?.perUnit).toBeCloseTo(1876.2122843899, 6)
    expect(basis?.quoteToken).toBe(USDT)
  })

  it('weights two opens by size rather than taking a plain mean', () => {
    // 10 WETH at 1,800 and 1 WETH at 2,000 is a basis of 1,818.18, not 1,900.
    const basis = avgEntryFromHistory(
      [
        buy({ hash: hash(1), at: 1_000, units: '10', price: 1800 }),
        buy({ hash: hash(2), at: 2_000, units: '1', price: 2000 }),
      ],
      WETH,
      'supply',
    )

    expect(basis?.perUnit).toBeCloseTo(1818.1818, 4)
  })

  it('counts an open paid for in a volatile token', () => {
    // Previously skipped for having no honest USD value. In token terms the question does not
    // arise: 0.05 WBTC per WETH is exactly what was paid, whatever BTC is worth today.
    const basis = avgEntryFromHistory(
      [entry({ srcToken: WBTC, srcDecimals: 8, spentAmount: wbtc(0.05), returnAmount: weth('1') })],
      WETH,
      'supply',
    )

    expect(basis?.perUnit).toBeCloseTo(0.05, 9)
    expect(basis?.quoteToken).toBe(WBTC)
  })

  it('refuses to add costs denominated in two different tokens', () => {
    // One paid in USDT, one in WBTC. There is no single token-denominated answer, and inventing
    // one needs the price conversion this function exists to avoid.
    const basis = avgEntryFromHistory(
      [
        buy({ hash: hash(1), at: 1_000, units: '1', price: 1800 }),
        entry({
          hash: hash(2), at: 2_000,
          srcToken: WBTC, srcDecimals: 8, spentAmount: wbtc(0.05), returnAmount: weth('1'),
        }),
      ],
      WETH,
      'supply',
    )

    expect(basis).toBeNull()
  })

  it('ignores an open that bought a different collateral', () => {
    expect(avgEntryFromHistory([entry({})], WBTC, 'supply')).toBeNull()
  })

  it('has nothing to price from a close with no open before it', () => {
    expect(avgEntryFromHistory([sell({ hash: hash(1), at: 1_000, units: '1' })], WETH, 'supply')).toBeNull()
  })

  it('ignores an open whose decimals were never recorded', () => {
    expect(avgEntryFromHistory([entry({ dstDecimals: null })], WETH, 'supply')).toBeNull()
  })

  it('has nothing to say about an empty history', () => {
    expect(avgEntryFromHistory([], WETH, 'supply')).toBeNull()
  })

  it('starts a fresh basis after a full close', () => {
    // open, open, close, open — the first two are GONE once the position is fully closed, so
    // their cost must not follow the new one around.
    const basis = avgEntryFromHistory(
      [
        buy({ hash: hash(1), at: 1_000, units: '10', price: 1800 }),
        buy({ hash: hash(2), at: 2_000, units: '1', price: 2000 }),
        sell({ hash: hash(3), at: 3_000, units: '11' }),
        buy({ hash: hash(4), at: 4_000, units: '2', price: 3000 }),
      ],
      WETH,
      'supply',
    )

    expect(basis?.perUnit).toBeCloseTo(3000, 6)
  })

  it('leaves the average alone when a close is only partial', () => {
    // Sell 5 of 10 bought at 1,800 and the 5 still held cost 1,800 each.
    const basis = avgEntryFromHistory(
      [
        buy({ hash: hash(1), at: 1_000, units: '10', price: 1800 }),
        sell({ hash: hash(2), at: 2_000, units: '5' }),
      ],
      WETH,
      'supply',
    )

    expect(basis?.perUnit).toBeCloseTo(1800, 6)
  })

  it('replays in time order however the rows arrive', () => {
    // `loadHistory` hands back newest-first, so a function trusting its caller's order would meet
    // the close before the opens it settles and reset nothing.
    const basis = avgEntryFromHistory(
      [
        buy({ hash: hash(4), at: 4_000, units: '2', price: 3000 }),
        sell({ hash: hash(3), at: 3_000, units: '11' }),
        buy({ hash: hash(2), at: 2_000, units: '1', price: 2000 }),
        buy({ hash: hash(1), at: 1_000, units: '10', price: 1800 }),
      ],
      WETH,
      'supply',
    )

    expect(basis?.perUnit).toBeCloseTo(3000, 6)
  })

  it('resets when a close sells more than the fills bought', () => {
    // Collateral accrues interest, so exiting sells more than was ever bought. Still a full exit.
    const basis = avgEntryFromHistory(
      [
        buy({ hash: hash(1), at: 1_000, units: '10', price: 1800 }),
        sell({ hash: hash(2), at: 2_000, units: '10.5' }),
        buy({ hash: hash(3), at: 3_000, units: '1', price: 3000 }),
      ],
      WETH,
      'supply',
    )

    expect(basis?.perUnit).toBeCloseTo(3000, 6)
  })

  /**
   * A short: USDT supplied as collateral, WETH borrowed and sold for it. Same shape as an open,
   * with the legs the other way round — the debt is the SOURCE.
   */
  const short = (o: { hash: Hex; at: number; units: string; price: number }) =>
    entry({
      hash: o.hash,
      at: o.at,
      srcToken: WETH,
      srcDecimals: 18,
      dstToken: USDT,
      dstDecimals: 6,
      spentAmount: weth(o.units),
      returnAmount: usdt(parseFloat(o.units) * o.price),
    })

  /** Closing a short buys the debt back, so the debt is the DESTINATION. */
  const cover = (o: { hash: Hex; at: number; units: string }) =>
    entry({
      hash: o.hash,
      at: o.at,
      kind: 'close',
      srcToken: USDT,
      srcDecimals: 6,
      dstToken: WETH,
      dstDecimals: 18,
      spentAmount: usdt(1),
      returnAmount: weth(o.units),
    })

  it('prices a short at what the borrowed asset was sold for', () => {
    // 2 WETH borrowed and sold for 3,800 USDT is a short entered at 1,900 USDT per WETH. Reading
    // the collateral leg instead would answer "WETH per USDT", which tells a shorter nothing.
    const basis = avgEntryFromHistory([short({ hash: hash(1), at: 1_000, units: '2', price: 1900 })], WETH, 'borrow')

    expect(basis?.perUnit).toBeCloseTo(1900, 6)
    expect(basis?.quoteToken).toBe(USDT)
  })

  it('weights two shorts by the debt each took on', () => {
    const basis = avgEntryFromHistory(
      [
        short({ hash: hash(1), at: 1_000, units: '10', price: 1800 }),
        short({ hash: hash(2), at: 2_000, units: '1', price: 2000 }),
      ],
      WETH,
      'borrow',
    )

    expect(basis?.perUnit).toBeCloseTo(1818.1818, 4)
  })

  it('starts a short fresh once the debt is fully covered', () => {
    const basis = avgEntryFromHistory(
      [
        short({ hash: hash(1), at: 1_000, units: '10', price: 1800 }),
        cover({ hash: hash(2), at: 2_000, units: '10' }),
        short({ hash: hash(3), at: 3_000, units: '2', price: 3000 }),
      ],
      WETH,
      'borrow',
    )

    expect(basis?.perUnit).toBeCloseTo(3000, 6)
  })

  it('does not read a long as though it were a short', () => {
    // The long's WETH is collateral, not debt. Asking for the borrow side must find nothing
    // rather than quote "WETH per USDT" as if it were a short entry.
    expect(avgEntryFromHistory([entry({})], WETH, 'borrow')).toBeNull()
  })

  it('blends the three real opens on Arbitrum position 0x1F0F4306', () => {
    // Verified against the chain: three PositionOpened events, no closes.
    const basis = avgEntryFromHistory(
      [
        entry({ hash: hash(3), at: 3_000, spentAmount: 4_374_538_636n, returnAmount: 2_309_194_102_159_342_953n }),
        entry({ hash: hash(2), at: 2_000, spentAmount: 2_200_000n, returnAmount: 1_157_347_352_571_367n }),
        entry({ hash: hash(1), at: 1_000, spentAmount: 67_754_406_950n, returnAmount: 36_112_335_215_858_211_266n }),
      ],
      WETH,
      'supply',
    )

    expect(basis?.perUnit).toBeCloseTo(1877.3061, 4)
  })
})
