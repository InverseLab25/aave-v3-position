import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'
import type { Address, Hex } from 'viem'
import { ConfirmLeverageModal } from './ConfirmLeverageModal'
import type { OpenPreview } from '../../hooks/useLeverageOpen'
import type { OpenProjection } from '../../lib/leverage'

const projection: OpenProjection = {
  expectedCollateral: 3n * 10n ** 18n,
  expectedDebt: 6000n * 10n ** 6n,
  totalCollateralUsd: 900_000_000_000n,
  totalDebtUsd: 600_000_000_000n,
  expectedLeverageBps: 30000n,
  expectedHealthFactorBps: 12450n,
  impliedLtvBps: 6666n,
  avgLtvBps: 8000n,
  avgLiquidationThresholdBps: 8300n,
}

const preview: OpenPreview = {
  collateral: '0x1111111111111111111111111111111111111111' as Address,
  debtAsset: '0x4444444444444444444444444444444444444444' as Address,
  marginAsset: '0x1111111111111111111111111111111111111111' as Address,
  flashAmount: 2n * 10n ** 18n,
  borrowAmount: 6000n * 10n ** 6n,
  swapIn: 6000n * 10n ** 6n,
  expectedOut: 2n * 10n ** 18n,
  minOut: 199n * 10n ** 16n,
  projection,
  router: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' as Address,
  swapData: '0xdeadbeef' as Hex,
  aggregator: 'KyberSwap',
  priceImpactPercent: 0.12,
}

function setup(over: Partial<Parameters<typeof ConfirmLeverageModal>[0]> = {}) {
  const props = {
    title: 'Open long WETH',
    marginLine: '1 WETH',
    supplyLine: '3 WETH',
    borrowLine: '6,000 USDC',
    preview,
    projection,
    isQuoting: false,
    previewMessage: null,
    showResign: false,
    priceImpactBlocked: false,
    slippageBps: 50n,
    collateralSymbol: 'WETH',
    debtSymbol: 'USDC',
    collateralDecimals: 18,
    debtDecimals: 6,
    step: 'idle' as const,
    execError: null,
    remedyHint: null,
    txHash: undefined,
    chainId: 8453,
    reusableSignature: null,
    onRefresh: vi.fn(),
    onResign: vi.fn(),
    onConfirm: vi.fn(),
    onClose: vi.fn(),
    ...over,
  }
  render(<ConfirmLeverageModal {...props} />)
  return props
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('shows what the position becomes, from the route rather than the form', () => {
  setup()

  expect(screen.getByText('3 WETH')).toBeDefined()
  expect(screen.getByText('6,000 USDC')).toBeDefined()
  expect(screen.getByText('KyberSwap')).toBeDefined()
  // 12450 bps of health factor, shown the way Aave states it.
  expect(screen.getByText('1.25')).toBeDefined()
})

it('re-prices the route on a cadence while it sits open', () => {
  const props = setup()

  act(() => void vi.advanceTimersByTime(3000))

  expect(props.onRefresh).toHaveBeenCalledTimes(1)
})

it('stops re-pricing once the wallet has the transaction', () => {
  // A quote landing mid-flow moves the figures under the user, and the delegation has already
  // committed to the borrow — refreshing can only spend rate-limit budget the send needs.
  const props = setup({ step: 'sending' })

  act(() => void vi.advanceTimersByTime(10_000))

  expect(props.onRefresh).not.toHaveBeenCalled()
})

it('does not stack a refresh on top of a quote still in flight', () => {
  const props = setup({ isQuoting: true })

  act(() => void vi.advanceTimersByTime(10_000))

  expect(props.onRefresh).not.toHaveBeenCalled()
})

it('refuses to confirm what it cannot price', () => {
  setup({ preview: null, isQuoting: true })

  expect(screen.getByRole('button', { name: 'Pricing…' }).hasAttribute('disabled')).toBe(true)
})

it('refuses to confirm a route giving too much away to price impact', () => {
  setup({ priceImpactBlocked: true })

  expect(screen.getByRole('button', { name: 'Confirm' }).hasAttribute('disabled')).toBe(true)
})

it('confirms with the route on screen', () => {
  const props = setup()

  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

  expect(props.onConfirm).toHaveBeenCalledTimes(1)
})

it('says when confirming will not prompt the wallet, and counts the signature down', () => {
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + 125n
  setup({ reusableSignature: { value: 6000n * 10n ** 6n, deadline } })

  expect(screen.getByText(/Delegation already signed/)).toBeDefined()
  expect(screen.getByText('2:05')).toBeDefined()

  act(() => void vi.advanceTimersByTime(5000))

  expect(screen.getByText('2:00')).toBeDefined()
})

it('offers to re-sign when the route has moved past the signed size', () => {
  // Waiting cannot fix this one: the borrow is pinned to the held signature, so the signature is
  // what has to give.
  const props = setup({ showResign: true })

  fireEvent.click(screen.getByRole('button', { name: 'Re-sign at the new size' }))

  expect(props.onResign).toHaveBeenCalledTimes(1)
})

it('reports a failed attempt with its remedy, and keeps the modal usable', () => {
  setup({ step: 'error', execError: 'Slippage exceeded', remedyHint: 'Try again with a wider slippage tolerance.' })

  expect(screen.getByText(/Slippage exceeded/)).toBeDefined()
  expect(screen.getByRole('button', { name: 'Confirm' }).hasAttribute('disabled')).toBe(false)
})

it('replaces confirmation with a receipt once the open has landed', () => {
  setup({ step: 'done', txHash: `0x${'11'.repeat(32)}` })

  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Done' })).toBeDefined()
})
