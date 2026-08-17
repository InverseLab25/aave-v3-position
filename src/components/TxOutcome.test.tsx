import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Address } from 'viem'
import { TxOutcomePanel, type TokenMeta } from './TxOutcome'
import type { TxOutcome } from '../lib/txOutcome'

const WETH: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const A_WETH: Address = '0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8'
const ROUTER: Address = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'

const tokens: Record<string, TokenMeta> = {
  [WETH.toLowerCase()]: { symbol: 'WETH', decimals: 18 },
  [USDC.toLowerCase()]: { symbol: 'USDC', decimals: 6 },
}

/** One WETH sold for 3,405.10 USDC, against a route that quoted 3,407.80. */
const outcome = (over: Partial<TxOutcome> = {}): TxOutcome => ({
  swap: {
    router: ROUTER,
    sender: ROUTER,
    srcToken: WETH,
    dstToken: USDC,
    dstReceiver: ROUTER,
    spentAmount: 10n ** 18n,
    returnAmount: 3405_100000n,
  },
  fill: { delta: -2_700000n, percent: -0.0792, belowFloor: false },
  deltas: [{ token: USDC, delta: 3405_100000n }],
  ...over,
})

const show = (o: TxOutcome | null, meta = tokens) =>
  render(<TxOutcomePanel outcome={o} tokens={meta} />)

describe('TxOutcomePanel', () => {
  it('renders nothing until a transaction has settled', () => {
    const { container } = show(null)

    expect(container.firstChild).toBeNull()
  })

  it('names what was sold and what came back', () => {
    show(outcome())

    expect(screen.getByText(/1\.000000 WETH → 3,405\.100000 USDC/)).toBeTruthy()
  })

  it('states the rate the swap actually filled at', () => {
    show(outcome())

    expect(screen.getByText(/1 WETH = 3,?405\.1/)).toBeTruthy()
  })

  it('reports a fill under the quote as an amount short, in the token received', () => {
    // An amount answers "how much did that cost me"; a percentage of a figure shown nowhere on the
    // panel does not. -2.7 USDC on a 3,405.1 USDC fill.
    show(outcome())

    expect(screen.getByText(/-2\.700000 USDC/)).toBeTruthy()
  })

  it('reports a fill above the quote the same way, signed the other direction', () => {
    show(outcome({ fill: { delta: 3_407800n, percent: 0.1, belowFloor: false } }))

    expect(screen.getByText(/\+3\.407800 USDC/)).toBeTruthy()
  })

  it('says nothing when the fill matched the quote to the displayed precision', () => {
    // A row reading "+0.000000 USDC" is a line whose content is that nothing happened.
    show(outcome({ fill: { delta: 0n, percent: 0, belowFloor: false } }))

    expect(screen.queryByText(/vs quote/)).toBeNull()
  })

  it('flags a fill that came in under the floor the transaction enforced', () => {
    show(outcome({ fill: { delta: -50_000000n, percent: -1.47, belowFloor: true } }))

    expect(screen.getByText(/below the floor/i)).toBeTruthy()
  })

  it('lists each wallet change with the direction it moved', () => {
    show(
      outcome({
        deltas: [
          { token: WETH, delta: -(10n ** 18n) },
          { token: USDC, delta: 3405_100000n },
        ],
      }),
    )

    expect(screen.getByText('−1.000000 WETH')).toBeTruthy()
    expect(screen.getByText('+3,405.100000 USDC')).toBeTruthy()
  })

  it('falls back to the address and raw units for a token it has no metadata for', () => {
    // Scaling by a guessed 18 decimals would print a number that looks right and is not.
    show(outcome({ deltas: [{ token: A_WETH, delta: 1198800000000000000n }] }))

    expect(screen.getByText(/0x4d5F…14E8/)).toBeTruthy()
    expect(screen.getByText(/1198800000000000000 raw units/)).toBeTruthy()
  })

  it('still reports the wallet changes when no swap was found in the receipt', () => {
    show(outcome({ swap: null, fill: null }))

    expect(screen.queryByText(/1 WETH =/)).toBeNull()
    expect(screen.getByText('+3,405.100000 USDC')).toBeTruthy()
  })
})
