import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Address, Hex } from 'viem'
import { useRecordOutcome } from './useRecordOutcome'
import { loadHistory } from '../lib/txHistory'
import type { TxOutcome } from '../lib/txOutcome'
import type { TokenMeta } from '../components/TxOutcome'

const WALLET = '0x1111111111111111111111111111111111111111' as Address
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address
const ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' as Address
const HASH = `0x${'11'.repeat(32)}` as Hex

const tokens: Record<string, TokenMeta> = {
  [WETH.toLowerCase()]: { symbol: 'WETH', decimals: 18 },
  [USDC.toLowerCase()]: { symbol: 'USDC', decimals: 6 },
}

/** One WETH sold for 3,405.10 USDC. */
const outcome: TxOutcome = {
  swap: {
    router: ROUTER,
    sender: ROUTER,
    srcToken: WETH,
    dstToken: USDC,
    dstReceiver: WALLET,
    spentAmount: 10n ** 18n,
    returnAmount: 3405_100000n,
  },
  fill: { delta: -2_700000n, percent: -0.0792, belowFloor: false, basis: 'simulated' as const },
  deltas: [{ token: USDC, delta: 3405_100000n }],
}

/** This repo's jsdom exposes no `localStorage`, so one is installed per test. */
function installStorage() {
  const map = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
    configurable: true,
  })
}

const record = (over: Partial<Parameters<typeof useRecordOutcome>[0]> = {}) =>
  renderHook(() =>
    useRecordOutcome({
      outcome,
      tokens,
      hash: HASH,
      chainId: 8453,
      wallet: WALLET,
      kind: 'open',
      ...over,
    }),
  )

describe('useRecordOutcome', () => {
  beforeEach(installStorage)

  it('writes down what the transaction settled at', () => {
    record()

    const [saved] = loadHistory(localStorage)
    expect(saved.hash).toBe(HASH)
    expect(saved.kind).toBe('open')
    expect(saved.swap?.returnAmount).toBe(3405_100000n)
    expect(saved.fill?.delta).toBe(-2_700000n)
  })

  it('writes down the rate the swap filled at, in the pair the user reads it as', () => {
    record()

    const [saved] = loadHistory(localStorage)
    expect(saved.rate).toBe('3405.1')
    expect(saved.swap?.srcSymbol).toBe('WETH')
    expect(saved.swap?.dstSymbol).toBe('USDC')
  })

  it('names the tokens that moved, so an old row still reads after the token list changes', () => {
    record()

    expect(loadHistory(localStorage)[0].deltas).toEqual([
      { token: USDC, symbol: 'USDC', decimals: 6, delta: 3405_100000n },
    ])
  })

  it('records one transaction once, however often it re-renders', () => {
    const { rerender } = record()
    rerender()
    rerender()

    expect(loadHistory(localStorage)).toHaveLength(1)
  })

  it('records nothing until there is an outcome to record', () => {
    record({ outcome: null })

    expect(loadHistory(localStorage)).toEqual([])
  })

  it('records nothing without a hash to file it under', () => {
    record({ hash: undefined })

    expect(loadHistory(localStorage)).toEqual([])
  })

  it('records nothing when no wallet is connected to attribute it to', () => {
    record({ wallet: undefined })

    expect(loadHistory(localStorage)).toEqual([])
  })

  it('leaves the rate unstated when the tokens are unknown', () => {
    // No decimals means no rate: two unscaled integers are not a price.
    record({ tokens: {} })

    expect(loadHistory(localStorage)[0].rate).toBeNull()
  })
})
