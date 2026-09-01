import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { parseUnits } from 'viem'
import type { BorrowedAsset, SuppliedAsset } from '../hooks/useAavePositions'

/**
 * The modal owns the two-press close flow: the first press banks an approval, the second spends
 * it. That contract lives half here and half in `useDeleverageClose`, and the hook's side is
 * covered by its own suite — so these mock the hook and assert on what the modal DOES with each
 * outcome it can be handed.
 *
 * The action button's own label is the clearest signal available: "Sign 2 approvals" before they
 * are held, "Confirm" once they are — the same word the open uses for the press that sends.
 */
const mocks = vi.hoisted(() => ({
  useConnection: vi.fn(),
  useChainId: vi.fn(),
  useConfig: vi.fn(),
  useWriteContract: vi.fn(),
  getChainConfig: vi.fn(),
  getStrategiesAddress: vi.fn(),
  useAdjustedGas: vi.fn(),
  useDeleverageClose: vi.fn(),
  simulateAndWrite: vi.fn(),
  clearQuoteCache: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useConnection: mocks.useConnection,
  useChainId: mocks.useChainId,
  useConfig: mocks.useConfig,
  useWriteContract: mocks.useWriteContract,
}))
vi.mock('../config/chains', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getChainConfig: mocks.getChainConfig,
  getStrategiesAddress: mocks.getStrategiesAddress,
}))
vi.mock('../hooks/useAdjustedGas', () => ({ useAdjustedGas: mocks.useAdjustedGas }))
vi.mock('../hooks/useDeleverageClose', () => ({ useDeleverageClose: mocks.useDeleverageClose }))
vi.mock('../utils/contract', () => ({ simulateAndWrite: mocks.simulateAndWrite }))
vi.mock('../adapters/http', () => ({ clearQuoteCache: mocks.clearQuoteCache }))
vi.mock('./ExplorerLink', () => ({ ExplorerLink: () => null }))

import { ClosePositionModal } from './ClosePositionModal'

const PNL = {
  avgEntryPriceUsd: 0,
  realizedPnlUsd: 0,
  unrealizedPriceGainUsd: 0,
  interestUsd: 0,
  totalPnlUsd: 0,
}

const WETH_SUPPLIED: SuppliedAsset = {
  symbol: 'WETH',
  underlyingAsset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  decimals: 18,
  amount: 10,
  amountRaw: parseUnits('10', 18),
  valueUsd: 30000,
  priceInUsd: '3000',
  apy: 2,
  aTokenAddress: '0x3333333333333333333333333333333333333333',
  usageAsCollateralEnabledOnUser: true,
  liquidationThreshold: 0.83,
  interestEarnedTokens: 0,
  interestEarnedUsd: 0,
  positionPnl: PNL,
}

const USDC_BORROWED: BorrowedAsset = {
  symbol: 'USDC',
  underlyingAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  decimals: 6,
  amount: 20000,
  amountRaw: parseUnits('20000', 6),
  valueUsd: 20000,
  priceInUsd: '1',
  apy: 5,
  variableDebtTokenAddress: '0x4444444444444444444444444444444444444444',
  interestPaidTokens: 0,
  interestPaidUsd: 0,
  positionPnl: PNL,
}

/** A preview the button will accept: covered by the collateral and guaranteed by the route. */
const okPreview = (over: Record<string, unknown> = {}) => ({
  covered: true,
  guaranteed: true,
  aggregator: 'KyberSwap',
  routes: [],
  collateralSymbol: 'WETH',
  debtSymbol: 'USDC',
  debtRepaid: '20000',
  collateralSwapped: '7',
  collateralKeptSupplied: '3',
  collateralKeptSuppliedUsd: 9000,
  minDebtOut: '20900',
  expectedDebtOut: '21000',
  debtRequired: '20100',
  debtReturned: '1000',
  rate: { unit: 'WETH', quote: 'USDC', rate: '3000', inverse: { unit: 'USDC', quote: 'WETH', rate: '0.000333' } },
  guaranteedRate: { unit: 'WETH', quote: 'USDC', rate: '2985', inverse: { unit: 'USDC', quote: 'WETH', rate: '0.000335' } },
  routeCostPercent: 0.05,
  swapGasEstimate: '450000',
  ...over,
})

let previewFn: ReturnType<typeof vi.fn>
let closeFn: ReturnType<typeof vi.fn>
let clearSignatures: ReturnType<typeof vi.fn>
let clearOutcome: ReturnType<typeof vi.fn>
let warmup: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useConnection.mockReturnValue({ address: '0x1111111111111111111111111111111111111111' })
  mocks.useChainId.mockReturnValue(1)
  mocks.useConfig.mockReturnValue({})
  mocks.useWriteContract.mockReturnValue({ mutateAsync: vi.fn() })
  mocks.getChainConfig.mockReturnValue({
    name: 'Ethereum',
    aave: { poolAddress: '0x8787878787878787878787878787878787878787' },
  })
  mocks.getStrategiesAddress.mockReturnValue('0x2222222222222222222222222222222222222222')
  mocks.useAdjustedGas.mockReturnValue({
    maxFee: 30_000_000_000n,
    maxPriority: 1_000_000_000n,
    estimatedFeeUsd: 12,
  })

  previewFn = vi.fn().mockResolvedValue({ preview: okPreview(), error: null })
  closeFn = vi.fn()
  clearSignatures = vi.fn()
  clearOutcome = vi.fn()
  warmup = vi.fn().mockResolvedValue(undefined)
  mocks.useDeleverageClose.mockReturnValue({
    preview: previewFn,
    close: closeFn,
    logs: [],
    step: 'idle',
    clearSignatures,
    clearOutcome,
    warmup,
  })
})

/** A second supplied asset, so the collateral select has something to switch between. */
const WBTC_SUPPLIED: SuppliedAsset = {
  ...WETH_SUPPLIED,
  symbol: 'WBTC',
  underlyingAsset: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  decimals: 8,
  aTokenAddress: '0x4444444444444444444444444444444444444444',
}

const mountWithBothCollaterals = () =>
  render(
    <ClosePositionModal
      borrowedAsset={USDC_BORROWED}
      suppliedAssets={[WETH_SUPPLIED, WBTC_SUPPLIED]}
      onClose={vi.fn()}
    />,
  )

const mount = () =>
  render(
    <ClosePositionModal
      borrowedAsset={USDC_BORROWED}
      suppliedAssets={[WETH_SUPPLIED]}
      onClose={vi.fn()}
    />,
  )

/** The action button, whichever of its three labels it currently wears. */
const actionButton = () =>
  screen.getByRole('button', { name: /Sign 2 approvals|Confirm|Processing|Pricing/ }) as HTMLButtonElement

const isEnabled = () => !actionButton().disabled

describe('ClosePositionModal — the action button gate', () => {
  it('offers to sign once a covered, guaranteed preview lands', async () => {
    mount()
    await waitFor(() => expect(isEnabled()).toBe(true))
    expect(actionButton().textContent).toContain('Sign 2 approvals')
  })

  it('stays disabled while there is no preview yet', () => {
    // The quote is debounced 300ms, so nothing has arrived on the first paint.
    mount()
    expect(isEnabled()).toBe(false)
  })

  it('refuses a position the collateral cannot cover', async () => {
    previewFn.mockResolvedValue({ preview: okPreview({ covered: false }), error: null })
    mount()

    await waitFor(() => expect(previewFn).toHaveBeenCalled())
    expect(isEnabled()).toBe(false)
  })

  it('refuses a route whose guaranteed output falls below the debt', async () => {
    // close() would refuse this anyway, so the button must not invite the click.
    previewFn.mockResolvedValue({ preview: okPreview({ guaranteed: false }), error: null })
    mount()

    await waitFor(() => expect(previewFn).toHaveBeenCalled())
    expect(isEnabled()).toBe(false)
  })
})

describe('ClosePositionModal — the two-press flow', () => {
  it('first press banks the approval and switches the button to Execute', async () => {
    closeFn.mockResolvedValue({
      hash: null,
      status: 'signed',
      signatureExpiresAt: Math.floor(Date.now() / 1000) + 300,
    })
    mount()
    await waitFor(() => expect(isEnabled()).toBe(true))

    fireEvent.click(actionButton())

    await waitFor(() => expect(actionButton().textContent).toContain('Confirm'))
    expect(closeFn).toHaveBeenCalledTimes(1)
  })

  it('second press submits, and the form resets so a third click cannot resubmit', async () => {
    closeFn
      .mockResolvedValueOnce({
        hash: null,
        status: 'signed',
        signatureExpiresAt: Math.floor(Date.now() / 1000) + 300,
      })
      .mockResolvedValueOnce({ hash: '0xabc', status: 'success' })
    mount()
    await waitFor(() => expect(isEnabled()).toBe(true))

    fireEvent.click(actionButton())
    await waitFor(() => expect(actionButton().textContent).toContain('Confirm'))
    fireEvent.click(actionButton())

    // The button is removed once it has landed, not merely disabled. Leaving it up offered to
    // close again — and a second attempt spends the same permit nonce and reverts, but not before
    // asking the user for another signature to find that out.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Sign 2 approvals|Confirm/ })).toBeNull()
    expect(closeFn).toHaveBeenCalledTimes(2)
  })

  it('re-quotes after a failure rather than leaving disproved numbers on screen', async () => {
    closeFn.mockResolvedValue({ hash: null, status: 'error', slippageTooTight: false })
    mount()
    await waitFor(() => expect(isEnabled()).toBe(true))
    const before = previewFn.mock.calls.length

    fireEvent.click(actionButton())

    // The hook already dropped the stale quote; the modal bumps refreshTick to pull a fresh one.
    await waitFor(() => expect(previewFn.mock.calls.length).toBeGreaterThan(before))
  })

  it('offers a wider tolerance when the aggregator refused on output', async () => {
    closeFn.mockResolvedValue({ hash: null, status: 'error', slippageTooTight: true })
    mount()
    await waitFor(() => expect(isEnabled()).toBe(true))

    fireEvent.click(actionButton())

    // A tolerance problem is offerable, not a dead end — the remedy is surfaced.
    await waitFor(() =>
      expect(screen.getByText('Max slippage is too tight for this route')).toBeTruthy(),
    )
  })
})

describe('ClosePositionModal — collateralIn is what reaches the hook', () => {
  const lastPreviewArg = () => previewFn.mock.calls.at(-1)?.[0]

  it('sends undefined when the field is empty — the debt sizes the swap', async () => {
    mount()
    await waitFor(() => expect(previewFn).toHaveBeenCalled())
    expect(lastPreviewArg()?.collateralIn).toBeUndefined()
  })

  it('parses a typed amount at the collateral decimals', async () => {
    mount()
    await waitFor(() => expect(previewFn).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText(/Auto|only what the repay needs/), { target: { value: '2.5' } })

    await waitFor(() => expect(lastPreviewArg()?.collateralIn).toBe(parseUnits('2.5', 18)))
  })

  // Both cases below start from a VALID amount on purpose. Going straight from empty to garbage
  // leaves the effective value at undefined either way, so the quote effect correctly does not
  // re-run — and a test asserting on that transition would pass without proving anything.
  it('falls back to undefined when a valid amount is replaced by an unparseable one', async () => {
    mount()
    const field = screen.getByPlaceholderText(/Auto|only what the repay needs/)

    fireEvent.change(field, { target: { value: '2.5' } })
    await waitFor(() => expect(lastPreviewArg()?.collateralIn).toBe(parseUnits('2.5', 18)))

    fireEvent.change(field, { target: { value: '1.2.3' } })
    await waitFor(() => expect(lastPreviewArg()?.collateralIn).toBeUndefined())
  })

  it('falls back to undefined when a valid amount is replaced by zero', async () => {
    // Zero is not "swap nothing" — it means fall back to letting the debt size the swap.
    mount()
    const field = screen.getByPlaceholderText(/Auto|only what the repay needs/)

    fireEvent.change(field, { target: { value: '2.5' } })
    await waitFor(() => expect(lastPreviewArg()?.collateralIn).toBe(parseUnits('2.5', 18)))

    fireEvent.change(field, { target: { value: '0' } })
    await waitFor(() => expect(lastPreviewArg()?.collateralIn).toBeUndefined())
  })
})

describe('ClosePositionModal — signature hygiene', () => {
  it('drops any held signature when the modal unmounts', async () => {
    // A signature must never outlive the modal that took it: it stays spendable for the rest of
    // its deadline otherwise.
    const { unmount } = mount()
    await waitFor(() => expect(previewFn).toHaveBeenCalled())

    unmount()

    expect(clearSignatures).toHaveBeenCalled()
  })

  it('warms the Aave wiring on open, ahead of the first quote', async () => {
    mount()
    await waitFor(() => expect(warmup).toHaveBeenCalled())
  })
})

it('forgets what the last close settled at when the collateral changes', () => {
  // The panel describes the pair it was produced for. Left up across a switch it captions the
  // new pair with the old one's numbers — and its position-token rows, filtered against the new
  // pair's aToken and debt token, stop being filtered and read as wallet balance changes.
  mountWithBothCollaterals()

  fireEvent.change(screen.getByRole('combobox'), {
    target: { value: WBTC_SUPPLIED.underlyingAsset },
  })

  expect(clearOutcome).toHaveBeenCalled()
})

describe('the close reports which of its three waits it is on', () => {
  /** The hook mock, with a step and a log line. */
  const atStep = (step: string, logs: string[] = []) =>
    mocks.useDeleverageClose.mockReturnValue({
      preview: previewFn, close: closeFn, logs, step, clearSignatures, clearOutcome, warmup,
    })

  it('names the two signatures and the swap, rather than one "Processing"', async () => {
    // A close needs a withdrawal permit, then the revoke that follows it at the next nonce, then
    // the transaction. One combined step could not tell a wallet that had not surfaced its second
    // prompt from a send already in flight.
    atStep('permit')
    mount()

    const progress = await screen.findByRole('status')
    expect(progress.textContent).toBe('withdraw · revoke · swap')
  })

  it('ticks the signatures once the transaction is going out', async () => {
    atStep('sending')
    mount()

    const progress = await screen.findByRole('status')
    expect(progress.textContent).toBe('✓ withdraw · ✓ revoke · swap')
  })

  it('shows no log lines at all', async () => {
    // The flow's own record — "Requesting permit signature (1 of 2)…", "Tx submitted: 0x…" — is
    // not something a user acts on, and the progress line above already says which wait they are
    // in. The open never showed its equivalent; nor does this now.
    atStep('revoke', ['Requesting permit signature (1 of 2)…', 'Requesting revoke signature (2 of 2)…'])
    mount()

    await screen.findByRole('status')
    expect(screen.queryByText(/Requesting permit signature/)).toBeNull()
    expect(screen.queryByText(/Requesting revoke signature/)).toBeNull()
  })

  it('still reports a failure, as a sentence rather than a log line', async () => {
    mocks.useDeleverageClose.mockReturnValue({
      preview: previewFn, close: closeFn, logs: ['Error: whatever'], step: 'error',
      execError: 'The close reverted on chain, so the debt was not repaid. Nothing was spent but gas.',
      clearSignatures, clearOutcome, warmup,
    })
    mount()

    expect(await screen.findByText(/reverted on chain, so the debt was not repaid/)).toBeTruthy()
  })
})

describe('the close uses the same controls as the open', () => {
  it('offers the shared slippage field, not its own copy of one', async () => {
    // The close had forty lines of hand-styled preset buttons duplicating SlippageField, which
    // meant the two transaction screens disagreed about what the same control looks like — and
    // the close's copy also clamped nothing, where the shared one enforces a ceiling.
    mount()

    const field = await screen.findByLabelText('Close max slippage percent')
    expect(field).toBeTruthy()
    expect((field as HTMLInputElement).max).toBe('50')
  })

  it('reports a slippage change to the quoting effect', async () => {
    mount()

    const field = await screen.findByLabelText('Close max slippage percent')
    fireEvent.change(field, { target: { value: '0.5' } })

    expect((field as HTMLInputElement).value).toBe('0.5')
  })
})

it('does not narrate the automatic sizing', async () => {
  // Two paragraphs used to say the same thing forty lines apart — that it swaps only enough to
  // repay the debt. Both are gone: the step line says what the wallet will ask for, and the
  // numbers in Estimated Output say what it will do.
  mount()

  await screen.findByLabelText('Close max slippage percent')
  expect(screen.queryByText(/is swapped for the router's guaranteed output/)).toBeNull()
  expect(screen.queryByText(/Execution Path/)).toBeNull()
})


describe('the close footer says what the next press does', () => {
  const withHook = (over: Record<string, unknown>) =>
    mocks.useDeleverageClose.mockReturnValue({
      preview: previewFn, close: closeFn, logs: [], step: 'idle',
      clearSignatures, clearOutcome, warmup, ...over,
    })

  it('says two approvals are coming, because two are', async () => {
    // It said "Sign Approval" — one — while the flow takes a withdrawal permit AND the revoke that
    // follows it, which the progress line directly above now spells out.
    withHook({})
    mount()

    expect(await screen.findByRole('button', { name: 'Sign 2 approvals' })).toBeTruthy()
  })

})

describe('ClosePositionModal — debtIn is what reaches the hook', () => {
  const lastPreviewArg = () => previewFn.mock.calls.at(-1)?.[0]
  const debtField = () => screen.getByPlaceholderText(/whole debt/i)

  it('sends undefined when the field is empty — the whole debt is repaid', async () => {
    mount()
    await waitFor(() => expect(previewFn).toHaveBeenCalled())
    expect(lastPreviewArg()?.debtIn).toBeUndefined()
  })

  it('parses a typed repay amount at the debt decimals', async () => {
    mount()
    await waitFor(() => expect(previewFn).toHaveBeenCalled())

    fireEvent.change(debtField(), { target: { value: '5000' } })

    await waitFor(() => expect(lastPreviewArg()?.debtIn).toBe(parseUnits('5000', 6)))
  })

  it("sends 'all' for MAX, so a full repay is exact rather than a rounded display number", async () => {
    mount()
    await waitFor(() => expect(previewFn).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'Repay MAX' }))

    await waitFor(() => expect(lastPreviewArg()?.debtIn).toBe('all'))
  })

  it('falls back to undefined when a valid amount is replaced by zero', async () => {
    mount()
    fireEvent.change(debtField(), { target: { value: '5000' } })
    await waitFor(() => expect(lastPreviewArg()?.debtIn).toBe(parseUnits('5000', 6)))

    fireEvent.change(debtField(), { target: { value: '0' } })
    await waitFor(() => expect(lastPreviewArg()?.debtIn).toBeUndefined())
  })
})

describe('ClosePositionModal — the health-factor gate on a partial close', () => {
  /**
   * A partial close removes collateral and debt in different proportions, so it can leave the
   * position closer to liquidation than it started. Aave enforces this inside the aToken's
   * `finalizeTransfer`, which means an unguarded plan reverts in the wallet after two
   * signatures — the guard has to be here, before the button invites the press.
   */
  const mountWithAccount = (preview: Record<string, unknown>) => {
    previewFn.mockResolvedValue({ preview: okPreview(preview), error: null })
    return render(
      <ClosePositionModal
        borrowedAsset={USDC_BORROWED}
        suppliedAssets={[WETH_SUPPLIED]}
        collateralUsd={30000}
        debtUsd={20000}
        liquidationThreshold={0.83}
        onClose={vi.fn()}
      />,
    )
  }

  it('blocks the press when the partial would leave the position near liquidation', async () => {
    // Sell 7 WETH ($21k) to repay only $2k of a $20k debt: collateral falls to $9k against
    // $18k of debt, which is an HF of 0.41.
    mountWithAccount({ debtRepaid: '2000', debtRemaining: '18000', collateralSwapped: '7' })

    await waitFor(() => expect(previewFn).toHaveBeenCalled())
    await waitFor(() => expect(isEnabled()).toBe(false))
    // getByText throws when absent, so this asserts the reason is on screen, not just the gate.
    expect(screen.getByText(/health factor/i).textContent).toContain('0.41')
  })

  it('allows a partial that leaves the position comfortably collateralised', async () => {
    // Sell 1 WETH ($3k) to repay $2k: $27k of collateral against $18k of debt, HF 1.24… still
    // under the warn line but well clear of the block line.
    mountWithAccount({ debtRepaid: '2000', debtRemaining: '18000', collateralSwapped: '1' })

    await waitFor(() => expect(isEnabled()).toBe(true))
  })

  it('does not gate a full close, which leaves no debt to be liquidated against', async () => {
    mountWithAccount({ debtRepaid: '20000', debtRemaining: '0', collateralSwapped: '7' })

    await waitFor(() => expect(isEnabled()).toBe(true))
  })
})

it('flips both rate rows together', async () => {
  // One control for both, deliberately. Un-inverted a worse fill is a SMALLER number and
  // inverted it is a LARGER one, so a guaranteed row that flipped on its own would show the
  // worse of the two rates as the better-looking figure sitting right under the expected one.
  mount()

  expect(await screen.findByText(/1 WETH = 3,000/)).toBeTruthy()
  expect(screen.getByText(/1 WETH = 2,985/)).toBeTruthy()

  fireEvent.click(screen.getAllByLabelText('Flip rate direction')[0])

  expect(screen.getByText(/1 USDC = 0.000333/)).toBeTruthy()
  expect(screen.getByText(/1 USDC = 0.000335/)).toBeTruthy()
})
