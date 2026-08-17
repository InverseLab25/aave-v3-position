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
    outcome: null,
    outcomeTokens: {},
    slippagePercent: 0.5,
    onSlippageChange: vi.fn(),
    reusableSignature: null,
    onRefresh: vi.fn(),
    onHardRefresh: vi.fn(),
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

it('says the swap is complete instead of still offering to open one', () => {
  // The heading still read "Open long WETH" after it had already been opened, which is the one
  // moment the title is answering a question nobody is asking any more.
  setup({ step: 'done', txHash: `0x${'11'.repeat(32)}` })

  expect(screen.getByText(/Swap complete/i)).toBeDefined()
  expect(screen.queryByText('Open long WETH')).toBeNull()
})

it('keeps its own title until the swap has actually landed', () => {
  setup({ step: 'sending' })

  expect(screen.getByText('Open long WETH')).toBeDefined()
  expect(screen.queryByText(/Swap complete/i)).toBeNull()
})

it('collapses to a receipt once the swap has landed', () => {
  // A settled modal is a report. Everything that belonged to DECIDING — the forecast, the route,
  // the tolerance, the step tracker — is answering a question that has already been answered, and
  // the settled panel below states what actually happened.
  setup({ step: 'done', txHash: `0x${'11'.repeat(32)}` })

  expect(screen.queryByRole('button', { name: /Refresh/ })).toBeNull()
  expect(screen.queryByText('Route')).toBeNull()
  expect(screen.queryByText(/MAX SLIPPAGE/i)).toBeNull()
  expect(screen.queryByText(/approved/)).toBeNull()
  expect(screen.queryByText('You supply')).toBeNull()
  expect(screen.queryByText('Health factor after')).toBeNull()
})

it('never warns about pricing a position it has already opened', () => {
  // The worst of them: a route that cannot be re-priced after the fact rendered "Could not price
  // this position — try a smaller supply" over a swap that had just succeeded.
  setup({
    step: 'done',
    txHash: `0x${'11'.repeat(32)}`,
    preview: null,
    previewMessage: 'Could not price this position — try a smaller supply',
  })

  expect(screen.queryByText(/Could not price/)).toBeNull()
})

it('still reports what the transaction settled at', () => {
  setup({ step: 'done', txHash: `0x${'11'.repeat(32)}` })

  expect(screen.getByText(/Swap complete/i)).toBeDefined()
  expect(screen.getByRole('button', { name: 'Done' })).toBeDefined()
})

it('can be dismissed from the header, not only from the footer', () => {
  // A settled modal is a report, and a report needs an exit that is not labelled like an action.
  const props = setup({ step: 'done', txHash: `0x${'11'.repeat(32)}` })

  fireEvent.click(screen.getByRole('button', { name: /close/i }))

  expect(props.onClose).toHaveBeenCalled()
})

it('offers the slippage presets and reports a pick to the caller', () => {
  const props = setup()

  fireEvent.click(screen.getByRole('button', { name: '1%' }))

  expect(props.onSlippageChange).toHaveBeenCalledWith(1)
})

it('accepts a typed slippage', () => {
  const props = setup()

  fireEvent.change(screen.getByLabelText('Confirm max slippage percent'), {
    target: { value: '1.25' },
  })

  expect(props.onSlippageChange).toHaveBeenCalledWith(1.25)
})

it('locks the tolerance once the transaction is with the wallet', () => {
  // Re-pricing mid-send moves `minOut` under a transaction already authorised at the old one.
  setup({ step: 'sending' })

  expect((screen.getByLabelText('Confirm max slippage percent') as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: '1%' }) as HTMLButtonElement).disabled).toBe(true)
})

it('warns that widening the tolerance can cost the held signature', () => {
  // Slippage re-seeds the borrow, and a signature covers one exact figure — so a big enough
  // change drops the pin and re-prompts. Saying so beforehand stops that looking random.
  setup({ reusableSignature: { value: 6000n * 10n ** 6n, deadline: 9_999_999_999n } })

  expect(screen.getByText(/re-sign/i)).toBeTruthy()
})

it('asks for a genuinely new price when the user presses Refresh', () => {
  // The poll and the button share a name but not an intent: the poll lives inside the quote
  // reuse window on purpose, and a press is a request to get out of it.
  const props = setup()

  fireEvent.click(screen.getByRole('button', { name: /refresh/i }))

  expect(props.onHardRefresh).toHaveBeenCalledTimes(1)
  expect(props.onRefresh).not.toHaveBeenCalled()
})
