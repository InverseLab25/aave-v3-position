import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LiquidationPriceBlock } from './LiquidationPriceBlock'
import { hasLiquidationRowsToShow } from '../utils/liquidation'
import type { LiquidationView } from '../utils/liquidation'

describe('LiquidationPriceBlock — non-modal, multiple rows', () => {
  it('renders "None" for a null row once the label is symbol-qualified', () => {
    // Two rows means each label carries its own symbol, so a null row reads as "USDC alone
    // cannot liquidate you" — attributed, not a claim about the whole position. This mode
    // (isModal unset) had no coverage before this change.
    const view: LiquidationView = {
      rows: [
        { symbol: 'WETH', liquidationPriceUsd: 2000, currentPriceUsd: 2500, bufferPct: -0.2, isVolatile: true },
        { symbol: 'USDC', liquidationPriceUsd: null, currentPriceUsd: 1, bufferPct: null, isVolatile: false },
      ],
      marketWideDropPct: null,
    }
    render(<LiquidationPriceBlock view={view} />)

    expect(screen.getByText('Liquidation price (WETH)').nextElementSibling?.textContent).toBe('$2000.00')
    expect(screen.getByText('Liquidation price (USDC)').nextElementSibling?.textContent).toBe('None')
  })
})

describe('LiquidationPriceBlock — single bare row', () => {
  it('drops a null row instead of rendering the unattributed "None"', () => {
    // One row means the label is bare ("Liquidation price"), naming the position rather than
    // an asset, so "None" there would misread as "this position cannot be liquidated".
    const view: LiquidationView = {
      rows: [
        { symbol: 'WETH', liquidationPriceUsd: null, currentPriceUsd: 2500, bufferPct: null, isVolatile: true },
      ],
      marketWideDropPct: null,
    }
    const { container } = render(<LiquidationPriceBlock view={view} />)

    expect(container.firstChild).toBeNull()
    expect(screen.queryByText('None')).toBeNull()
    expect(screen.queryByText(/Liquidation price/)).toBeNull()
  })
})

describe('LiquidationPriceBlock agrees with hasLiquidationRowsToShow', () => {
  const cases: Array<[string, LiquidationView]> = [
    ['no rows at all', { rows: [], marketWideDropPct: null }],
    [
      'a single null row',
      {
        rows: [{ symbol: 'WETH', liquidationPriceUsd: null, currentPriceUsd: 2500, bufferPct: null, isVolatile: true }],
        marketWideDropPct: null,
      },
    ],
    [
      'a single priced row',
      {
        rows: [{ symbol: 'WETH', liquidationPriceUsd: 2000, currentPriceUsd: 2500, bufferPct: -0.2, isVolatile: true }],
        marketWideDropPct: null,
      },
    ],
    [
      'two null rows',
      {
        rows: [
          { symbol: 'WETH', liquidationPriceUsd: null, currentPriceUsd: 2500, bufferPct: null, isVolatile: true },
          { symbol: 'USDC', liquidationPriceUsd: null, currentPriceUsd: 1, bufferPct: null, isVolatile: false },
        ],
        marketWideDropPct: null,
      },
    ],
  ]

  it.each(cases)('where the predicate says nothing to show (%s), the block renders nothing', (_label, view) => {
    const { container } = render(<LiquidationPriceBlock view={view} />)
    expect(hasLiquidationRowsToShow(view)).toBe(container.firstChild !== null)
  })
})
