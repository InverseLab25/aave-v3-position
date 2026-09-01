/**
 * What the Open button does before the confirmation modal exists.
 *
 * It takes the margin APPROVAL and nothing else. The panel prices nothing now, so there is no
 * route here to wait for — and the delegation cannot be taken until one exists, because it signs
 * an exact borrow the contract matches exactly. So this button answers immediately, asks the
 * wallet at most once, and opens the modal only if the approval was actually granted.
 *
 * `useLeverageOpen` is faked here on purpose: what it does with a signature has its own suite, and
 * what is under test is the wiring around it.
 */
import { beforeEach, expect, it, vi } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { Address } from 'viem'
import type { AvailableReserve } from '../../hooks/useAavePositions'

const STRATEGIES = '0x000000000000000000000000000000000000bEEF' as Address
const OWNER = '0x000000000000000000000000000000000000dEaD' as Address
const WETH = '0x4200000000000000000000000000000000000006' as Address
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address

const mocks = vi.hoisted(() => ({
  useChainId: vi.fn(),
  useConnection: vi.fn(),
  useReadContract: vi.fn(),
  getStrategiesAddress: vi.fn(),
  useLeverageOpen: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useChainId: mocks.useChainId,
  useConnection: mocks.useConnection,
  useReadContract: mocks.useReadContract,
}))
vi.mock('../../config/chains', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getStrategiesAddress: mocks.getStrategiesAddress,
}))
vi.mock('../../hooks/useLeverageOpen', () => ({ useLeverageOpen: mocks.useLeverageOpen }))

import { LeveragePanel } from './LeveragePanel'

function reserve(over: Partial<AvailableReserve> & Pick<AvailableReserve, 'symbol' | 'underlyingAsset'>): AvailableReserve {
  return {
    decimals: 18,
    priceInUsd: '2000',
    apy: 1,
    borrowApy: 3,
    variableDebtTokenAddress: '0x0000000000000000000000000000000000000001',
    aTokenAddress: '0x0000000000000000000000000000000000000002',
    liquidationThreshold: 0.83,
    raw: {
      ltvBps: 8000n,
      liquidationThresholdBps: 8300n,
      priceUsd: 2000_00000000n,
      decimals: 18,
      usageAsCollateralEnabled: true,
      debtCeiling: 0n,
    },
    ...over,
  } as AvailableReserve
}

const RESERVES = [
  reserve({ symbol: 'WETH', underlyingAsset: WETH }),
  reserve({
    symbol: 'USDC', underlyingAsset: USDC, decimals: 6, priceInUsd: '1',
    raw: {
      ltvBps: 7700n, liquidationThresholdBps: 8000n, priceUsd: 1_00000000n, decimals: 6,
      usageAsCollateralEnabled: true, debtCeiling: 0n,
    },
  }),
]

/** The hook's return, rebuilt per render so the panel sees whatever the test has set. */
let hookState: Record<string, unknown>
const approve = vi.fn<() => Promise<boolean>>()
const prepare = vi.fn<() => Promise<boolean>>()
const submit = vi.fn<() => Promise<void>>()

function setHook(over: Record<string, unknown> = {}) {
  hookState = {
    preview: null,
    previewError: null,
    routes: [],
    measuredOut: {},
    isQuoting: false,
    step: 'idle',
    txHash: undefined,
    execError: null,
    execRemedy: null,
    approve,
    prepare,
    submit,
    refresh: vi.fn(),
    hardRefresh: vi.fn(),
    reset: vi.fn(),
    reusableSignature: null,
    pinnedBorrow: null,
    forgetSignature: vi.fn(),
    ...over,
  }
  mocks.useLeverageOpen.mockImplementation(() => hookState)
}

/** A preview good enough for the panel to render a route and enable Confirm. */
const PREVIEW = {
  collateral: WETH,
  debtAsset: USDC,
  marginAsset: USDC,
  flashAmount: 10n ** 18n,
  borrowAmount: 2000_000000n,
  swapIn: 2000_000000n,
  expectedOut: 10n ** 18n,
  minOut: 10n ** 18n,
  projection: {
    expectedCollateral: 10n ** 18n,
    expectedDebt: 2000_000000n,
    totalCollateralUsd: 2000_00000000n,
    totalDebtUsd: 1000_00000000n,
    expectedLeverageBps: 20_000n,
    expectedHealthFactorBps: 16_600n,
    impliedLtvBps: 5000n,
    avgLtvBps: 8000n,
    avgLiquidationThresholdBps: 8300n,
  },
  router: '0x0000000000000000000000000000000000000003',
  swapData: '0xdead',
  aggregator: 'KyberSwap',
  priceImpactPercent: 0.1,
}

function mount() {
  return render(
    <LeveragePanel
      suppliedAssets={[]}
      borrowedAssets={[]}
      availableReserves={RESERVES}
      collateralFlags={{}}
      hasAnyCollateralEnabled={false}
      eModeExcludedReserves={{}}
      existingCollateralUsd={0n}
      existingDebtUsd={0n}
      existingLtvBps={0n}
      existingLiquidationThresholdBps={0n}
    />,
  )
}

/** Fills both amounts, so `validateSizing` passes and the panel builds a non-null input. */
function fillForm() {
  fireEvent.change(screen.getByLabelText('Margin amount'), { target: { value: '1000' } })
  fireEvent.change(screen.getByLabelText('Supply to Aave amount'), { target: { value: '1' } })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useChainId.mockReturnValue(8453)
  mocks.useConnection.mockReturnValue({ address: OWNER })
  // The margin balance, comfortably covering anything typed below.
  mocks.useReadContract.mockReturnValue({ data: 10n ** 30n })
  mocks.getStrategiesAddress.mockReturnValue(STRATEGIES)
  approve.mockResolvedValue(true)
  prepare.mockResolvedValue(true)
  submit.mockResolvedValue(undefined)
  setHook()
})

it('opens the confirmation without waiting for a route', async () => {
  // The point of the split. Nothing here is priced, so a press that gates on a preview would
  // gate on something that is never coming.
  setHook({ preview: null })
  mount()
  fillForm()

  fireEvent.click(screen.getByRole('button', { name: /Open long/i }))

  await waitFor(() => expect(approve).toHaveBeenCalledTimes(1))
  // The modal is up; its action still reads "Pricing…" because no route has landed yet, which is
  // the honest label for a button with nothing to send.
  expect(await screen.findByRole('button', { name: 'Cancel' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Pricing…' })).toBeTruthy()
  // The borrow has not been solved yet, so there is nothing legitimate to sign over.
  expect(prepare).not.toHaveBeenCalled()
})

it('asks the wallet once however fast the button is pressed', async () => {
  // `approve` reads the pause state before it touches `step`, so `busy` lags the first click by
  // a tick. Without the ref guard a double click lands in that window and prompts twice.
  mount()
  fillForm()

  const button = screen.getByRole('button', { name: /Open long/i })
  fireEvent.click(button)
  fireEvent.click(button)
  fireEvent.click(button)

  await waitFor(() => expect(approve).toHaveBeenCalledTimes(1))
  await act(async () => {})
  expect(approve).toHaveBeenCalledTimes(1)
})

it('opens the confirmation once the approval is granted', async () => {
  setHook({ preview: PREVIEW })
  mount()
  fillForm()

  fireEvent.click(screen.getByRole('button', { name: /Open long/i }))

  await waitFor(() => expect(approve).toHaveBeenCalledTimes(1))
  // The modal is where the pricing, the signature and the send all now live.
  expect(await screen.findByRole('button', { name: 'Confirm' })).toBeTruthy()
})

it('keeps the confirmation open when the reserve list churns underneath it', async () => {
  // The modal used to be gated on `collateralReserve && debtReserve`, which are derived from
  // refetchable position data. Any refetch that briefly emptied the reserve list therefore
  // UNMOUNTED the modal mid-transaction — and on the boost path that is the ordinary sequence,
  // because a successful open changes the position and provokes exactly that refetch. The receipt
  // arrives at the same moment, so the settled report was destroyed as it was being written.
  setHook({ preview: PREVIEW })
  const view = mount()
  fillForm()

  fireEvent.click(screen.getByRole('button', { name: /Open long/i }))
  await screen.findByRole('button', { name: 'Confirm' })

  // A refetch in flight: same props, nothing resolvable in the list.
  view.rerender(
    <LeveragePanel
      suppliedAssets={[]}
      borrowedAssets={[]}
      availableReserves={[]}
      collateralFlags={{}}
      hasAnyCollateralEnabled={false}
      eModeExcludedReserves={{}}
      existingCollateralUsd={0n}
      existingDebtUsd={0n}
      existingLtvBps={0n}
      existingLiquidationThresholdBps={0n}
    />,
  )

  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeTruthy()
})

it('leaves the user on the form when the wallet is rejected', async () => {
  approve.mockResolvedValue(false)
  setHook({ preview: PREVIEW })
  mount()
  fillForm()

  fireEvent.click(screen.getByRole('button', { name: /Open long/i }))

  await waitFor(() => expect(approve).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  // And the button comes back, rather than staying stuck mid-press.
  expect(await screen.findByRole('button', { name: /Open long/i })).toBeTruthy()
})

it('leaves the position tokens out of the settled wallet changes', async () => {
  // Aave mints the aToken and the debt token to the wallet, so both net into the receipt's
  // deltas — but they are the POSITION, which the projection in this very modal describes.
  prepare.mockResolvedValue(true)
  setHook({
    preview: PREVIEW,
    outcome: {
      swap: null,
      fill: null,
      deltas: [
        { token: '0x0000000000000000000000000000000000000002', delta: 5n * 10n ** 18n },
        { token: '0x0000000000000000000000000000000000000001', delta: 9n * 10n ** 18n },
        { token: WETH, delta: -(2n * 10n ** 18n) },
      ],
    },
  })
  mount()
  fillForm()

  fireEvent.click(screen.getByRole('button', { name: /Open long/i }))
  await screen.findByRole('button', { name: 'Confirm' })

  expect(screen.getByText('−2.000000 WETH')).toBeTruthy()
  expect(screen.queryByText(/raw units/)).toBeNull()
})

it('records the settled transaction, which the position screen is what displays', async () => {
  const map = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
    configurable: true,
  })

  setHook({
    preview: PREVIEW,
    step: 'done',
    txHash: `0x${'11'.repeat(32)}`,
    outcome: { swap: null, fill: null, deltas: [{ token: WETH, delta: -(2n * 10n ** 18n) }] },
  })
  mount()

  // The panel is where an open is WRITTEN down; AavePosition is where the list is read. Keeping
  // the two apart is why this asserts storage rather than the screen.
  const rows = JSON.parse(map.get('defi-route.txhistory.v1') ?? '[]')
  expect(rows).toHaveLength(1)
  expect(rows[0].kind).toBe('open')
  expect(screen.queryByText(/Recent activity/)).toBeNull()

})

it('leaves the settled report to the confirmation and the history row', () => {
  // The panel used to render a second copy, because `step` reaches 'done' on the hash — a block or
  // more before the receipt — so the natural sequence (Confirm, see Done, press Done) closed the
  // only place the figures appeared.
  //
  // That reasoning has expired. `useRecordOutcome` lives on this panel, so it writes the history
  // row whenever the receipt resolves, and Recent activity renders it on this same screen. The
  // duplicate was showing the same numbers twice.
  setHook({
    preview: PREVIEW,
    step: 'done',
    txHash: `0x${'11'.repeat(32)}`,
    outcome: {
      swap: null,
      fill: null,
      deltas: [{ token: WETH, delta: -(2n * 10n ** 18n) }],
    },
  })
  mount()

  expect(screen.queryByText('Settled')).toBeNull()
})

it('records the settled transaction, which the position screen is what displays', async () => {
  const map = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
    configurable: true,
  })

  setHook({
    preview: PREVIEW,
    step: 'done',
    txHash: `0x${'11'.repeat(32)}`,
    outcome: { swap: null, fill: null, deltas: [{ token: WETH, delta: -(2n * 10n ** 18n) }] },
  })
  mount()

  // The panel is where an open is WRITTEN down; AavePosition is where the list is read. Keeping
  // the two apart is why this asserts storage rather than the screen.
  const rows = JSON.parse(map.get('defi-route.txhistory.v1') ?? '[]')
  expect(rows).toHaveLength(1)
  expect(rows[0].kind).toBe('open')
  expect(screen.queryByText(/Recent activity/)).toBeNull()

})

it('records the settled transaction, which the position screen is what displays', async () => {
  const map = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
    configurable: true,
  })

  setHook({
    preview: PREVIEW,
    step: 'done',
    txHash: `0x${'11'.repeat(32)}`,
    outcome: { swap: null, fill: null, deltas: [{ token: WETH, delta: -(2n * 10n ** 18n) }] },
  })
  mount()

  // The panel is where an open is WRITTEN down; AavePosition is where the list is read. Keeping
  // the two apart is why this asserts storage rather than the screen.
  const rows = JSON.parse(map.get('defi-route.txhistory.v1') ?? '[]')
  expect(rows).toHaveLength(1)
  expect(rows[0].kind).toBe('open')
  expect(screen.queryByText(/Recent activity/)).toBeNull()

})

it('records the settled transaction, which the position screen is what displays', async () => {
  const map = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
    configurable: true,
  })

  setHook({
    preview: PREVIEW,
    step: 'done',
    txHash: `0x${'11'.repeat(32)}`,
    outcome: { swap: null, fill: null, deltas: [{ token: WETH, delta: -(2n * 10n ** 18n) }] },
  })
  mount()

  // The panel is where an open is WRITTEN down; AavePosition is where the list is read. Keeping
  // the two apart is why this asserts storage rather than the screen.
  const rows = JSON.parse(map.get('defi-route.txhistory.v1') ?? '[]')
  expect(rows).toHaveLength(1)
  expect(rows[0].kind).toBe('open')
  expect(screen.queryByText(/Recent activity/)).toBeNull()

})

it('says nothing about empty fields until one of them is filled in', () => {
  // A form that has never been touched is not a form with a mistake in it. Loading the page
  // straight into red text reads as something already being wrong, and the two codes that fire
  // here — NO_MARGIN and NO_SUPPLY — are only ever "you have not typed this yet".
  mount()

  expect(screen.queryByText(/Enter how much/i)).toBeNull()
})

it('prompts for the field still missing once the other one is filled in', () => {
  // The mirror. Suppressing the prompt outright would leave a user who filled one box with a
  // dead Open button and nothing saying which box is still empty.
  mount()

  fireEvent.change(screen.getByLabelText('Supply to Aave amount'), { target: { value: '1' } })

  expect(screen.getByText(/Enter how much/i)).toBeTruthy()
})
