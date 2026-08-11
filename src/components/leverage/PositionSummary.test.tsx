import { describe, it, expect } from 'vitest'
import type { ComponentProps } from 'react'
import { render, screen, within } from '@testing-library/react'
import { parseUnits } from 'viem'
import { PositionSummary } from './PositionSummary'
import type { OpenProjection } from '../../lib/leverage'

/**
 * PositionSummary is the card a user reads to decide whether to open a leveraged position, so
 * every figure on it is one they act on. It is pure presentation over `accountStats`, which has
 * its own coverage — these pin the FORMATTING and the before/after contract, which is where a
 * number goes wrong without anything throwing.
 *
 * The rule that matters: the "after" side only appears once there is something to show. Until
 * then the card reads as a plain statement of what the account already is.
 */
/**
 * NOTE ON WHICH FIELDS MATTER. The card does not read `expectedLeverageBps`,
 * `expectedHealthFactorBps` or `impliedLtvBps` at all — it re-derives every ratio through
 * `accountStats` from the TOTALS. Setting those fields and asserting on them passes by
 * coincidence whenever the totals happen to agree, which is exactly how three assertions here
 * were green for the wrong reason until a mutation exposed it. Drive the totals.
 *
 * 90,000 collateral against 60,000 debt at a 0.825 threshold gives 30,000 of equity — so 3.00x
 * exposure, a 1.24 health factor, and 83.33% of an 80% borrow power used.
 */
const projection = (over: Partial<OpenProjection> = {}): OpenProjection => ({
  expectedCollateral: parseUnits('30', 18),
  expectedDebt: parseUnits('60000', 6),
  totalCollateralUsd: 90_000_00000000n,
  totalDebtUsd: 60_000_00000000n,
  avgLtvBps: 8_000n,
  avgLiquidationThresholdBps: 8_250n,
  // Present because the type demands them; NOT read by this component.
  expectedLeverageBps: 0n,
  expectedHealthFactorBps: 0n,
  impliedLtvBps: 0n,
  ...over,
})

const base = {
  preview: null,
  projection: null,
  isEstimate: false,
  direction: 'long' as const,
  subjectSymbol: 'WETH',
  flashAmount: parseUnits('20', 18),
  collateralSymbol: 'WETH',
  debtSymbol: 'USDC',
  collateralDecimals: 18,
  debtDecimals: 6,
  collateralPriceUsd: 3000,
  debtPriceUsd: 1,
  liquidationThreshold: 0.825,
  existingCollateral: [],
  existingCollateralUsd: 0n,
  existingDebtUsd: 0n,
  existingLtvBps: 8_000n,
  existingLiquidationThresholdBps: 8_250n,
  existingCollateralAmount: 0n,
  existingDebtAmount: 0n,
}

const mount = (props: Record<string, unknown> = {}) => {
  const merged = { ...base, ...props } as unknown as ComponentProps<typeof PositionSummary>
  return render(<PositionSummary {...merged} />)
}

/** A labelled row, scoped so a figure is read from the row that claims it. */
const row = (label: string | RegExp) =>
  within(screen.getByText(label).parentElement!)

describe('PositionSummary — the before/after contract', () => {
  it('shows only the current account until there is a projection', () => {
    // Scoped to a row on purpose: the card HEADER reads "now → after", so a bare arrow search
    // matches whether or not any row has an after side.
    mount()
    expect(row('Exposure').queryByText(/→/)).toBeNull()
  })

  it('adds the after side once a projection arrives', () => {
    mount({ projection: projection() })
    expect(row('Exposure').getByText(/→/)).toBeTruthy()
  })

  it('labels the card as an estimate while the figures are pre-quote', () => {
    mount({ projection: projection(), isEstimate: true })
    expect(screen.getByText('estimated')).toBeTruthy()
  })

  it('labels it as a settled before/after once a route has answered', () => {
    mount({ projection: projection(), isEstimate: false })
    expect(screen.getByText('now → after')).toBeTruthy()
  })
})

describe('PositionSummary — formatting', () => {
  it('renders leverage as a multiple', () => {
    // An empty account has no equity ratio to show, so the before side reads as 1.00x.
    mount()
    expect(row('Exposure').getByText('1.00x')).toBeTruthy()
  })

  it('renders the projected leverage as collateral over equity', () => {
    // 90,000 collateral over 30,000 of equity = 3.00x, derived from the totals.
    mount({ projection: projection() })
    expect(row('Exposure').getByText(/3\.00x/)).toBeTruthy()
  })

  it('renders a health factor to two places', () => {
    // 90,000 x 0.825 / 60,000 = 1.2375
    mount({ projection: projection() })
    expect(row('Health factor').getByText(/1\.24/)).toBeTruthy()
  })

  it('renders an unliquidatable health factor as infinite', () => {
    // 90,000 x 0.825 / 100 = 742.5, past the cap. The existing account keeps real debt so the
    // BEFORE side stays finite — with a debt-free account both sides read ∞ and this would pass
    // with the cap removed entirely, which is what a mutation caught.
    mount({
      existingCollateralUsd: 30_000_00000000n,
      existingDebtUsd: 20_000_00000000n,
      projection: projection({ totalDebtUsd: 100_00000000n }),
    })

    // Read off the row's own text rather than through a matcher: the after side is rendered as
    // an arrow and a value in separate text nodes, which no single-element matcher sees whole.
    const hf = screen.getByText('Health factor').parentElement!.textContent ?? ''
    expect(hf).toContain('1.24') // before, finite
    expect(hf).toContain('∞') // after, capped
    expect(hf).not.toContain('200.00') // the uncapped value must not survive
  })

  it('shows a debt-free account as infinite before any projection', () => {
    mount()
    expect(row('Health factor').getByText('∞')).toBeTruthy()
  })

  it('renders borrow power used as a percentage from bps', () => {
    // accountStats derives this, so it is debt over borrow POWER, not the implied LTV:
    // 90,000 collateral x 0.80 = 72,000 of power, and 60,000 of debt against it is 83.33%.
    mount({ projection: projection() })
    expect(row('Borrow power used').getByText(/83\.33%/)).toBeTruthy()
  })

  it('shows zero borrow power used on an untouched account', () => {
    mount()
    expect(row('Borrow power used').getByText('0.00%')).toBeTruthy()
  })

  it('renders the supplied and borrowed legs in their own decimals', () => {
    // 18 decimals for WETH, 6 for USDC — reading one at the other's scale is off by 10^12.
    mount({ projection: projection() })

    expect(row('Supplied').getByText(/30\.0000 WETH/)).toBeTruthy()
    expect(row('Borrowed').getByText(/60,?000\.0000 USDC/)).toBeTruthy()
  })

  it('adds the projection to what the account already holds', () => {
    // The after side is existing PLUS projected, not the projection alone — on a boost the
    // absolute figure is what the user ends up with.
    mount({
      existingCollateralAmount: parseUnits('10', 18),
      existingDebtAmount: parseUnits('5000', 6),
      projection: projection(),
    })

    expect(row('Supplied').getByText(/40\.0000 WETH/)).toBeTruthy()
    expect(row('Borrowed').getByText(/65,?000\.0000 USDC/)).toBeTruthy()
  })
})

describe('PositionSummary — the liquidation price', () => {
  it('reads as None while there is nothing to be liquidated', () => {
    mount()
    expect(row(/liquidation price/).getByText('None')).toBeTruthy()
  })

  it('names the subject asset, since that is what gets liquidated', () => {
    mount({ subjectSymbol: 'WBTC' })
    expect(screen.getByText(/WBTC liquidation price/)).toBeTruthy()
  })
})
