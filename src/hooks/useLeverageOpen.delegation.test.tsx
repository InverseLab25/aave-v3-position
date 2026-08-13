/**
 * The delegation signature's life across attempts: taken once, held, spent again on the retry,
 * and dropped the moment it can no longer authorise what is on screen.
 *
 * A fake adapter stands in for the aggregator so a preview actually forms — `execute` returns
 * early without one, and every assertion here is about what `execute` does.
 */
import { beforeEach, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { Address } from 'viem'
import type { Adapter, QuoteResponse, TransactionPayload } from '../adapters/types'

const ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'
const STRATEGIES = '0x000000000000000000000000000000000000bEEF' as Address
const OWNER = '0x000000000000000000000000000000000000dEaD' as Address
const COLLATERAL = '0x1111111111111111111111111111111111111111' as Address
const DEBT = '0x4444444444444444444444444444444444444444' as Address
const V_DEBT = '0x5555555555555555555555555555555555555555' as Address
const CHAIN_ID = 8453

const mocks = vi.hoisted(() => ({
  getPauseState: vi.fn(),
  getAllowedRouters: vi.fn(),
  getDelegationAllowance: vi.fn(),
  getPermitContext: vi.fn(),
  getPoolDataProvider: vi.fn(),
  getReserveTokens: vi.fn(),
  getAdaptersForChain: vi.fn(),
  usePublicClient: vi.fn(),
  useChainId: vi.fn(),
  useConnection: vi.fn(),
  useWriteContract: vi.fn(),
  useSignTypedData: vi.fn(),
}))

vi.mock('../lib/strategies-sdk', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getPauseState: mocks.getPauseState,
  getAllowedRouters: mocks.getAllowedRouters,
  getDelegationAllowance: mocks.getDelegationAllowance,
  getPermitContext: mocks.getPermitContext,
}))
vi.mock('../lib/aaveStatics', () => ({
  getPoolDataProvider: mocks.getPoolDataProvider,
  getReserveTokens: mocks.getReserveTokens,
}))
vi.mock('../adapters', () => ({ getAdaptersForChain: mocks.getAdaptersForChain }))
vi.mock('wagmi', () => ({
  usePublicClient: mocks.usePublicClient,
  useChainId: mocks.useChainId,
  useConnection: mocks.useConnection,
  useWriteContract: mocks.useWriteContract,
  useSignTypedData: mocks.useSignTypedData,
}))

import { delegationKey, loadDelegation, MIN_DELEGATION_REMAINING_S } from '../lib/delegationCache'
import { useLeverageOpen, type LeverageOpenInput } from './useLeverageOpen'

const KEY = delegationKey({ chainId: CHAIN_ID, owner: OWNER, debtAsset: DEBT })
const NONCE = 7n
// r ‖ s ‖ v, with v = 27. `toStrategiesSig` runs viem's `parseSignature` over this, which
// rejects any other trailing byte — a filler signature fails the flow before the send.
const SIGNATURE = `0x${'ab'.repeat(32)}${'cd'.repeat(32)}1b` as const

/**
 * The pair's rate, in debt per collateral. Flat, so the borrow the solver lands on is a function
 * of the supply alone — and moves only when a test moves this.
 */
let debtPerCollateral = 3000n

/**
 * Prices the pair at {@link debtPerCollateral}, so the borrow the solver lands on is a
 * function of the supply alone and moves only when the test moves it.
 */
function fakeAdapter(): Adapter {
  return {
    name: 'KyberSwap',
    supportsExecution: true,
    getQuote: vi.fn(async (_from, _to, amountIn): Promise<QuoteResponse> => ({
      aggregator: 'KyberSwap',
      amountIn,
      // debt (6dp) → collateral (18dp) at the current rate.
      amountOut: ((BigInt(amountIn) * 10n ** 18n) / (debtPerCollateral * 10n ** 6n)).toString(),
      amountOutUsd: '0',
      gasUsd: '0',
      netReturnUsd: 0,
      routeDetails: { protocol: 'KyberSwap', path: [] } as unknown as QuoteResponse['routeDetails'],
      rawQuote: {},
    })),
    buildTransaction: vi.fn(async (quote): Promise<TransactionPayload> => ({
      to: ROUTER,
      spender: ROUTER,
      data: '0xdeadbeef',
      value: '0',
      amountOut: quote.amountOut,
    })),
  }
}

function makeInput(over: Partial<LeverageOpenInput> = {}): LeverageOpenInput {
  return {
    contract: STRATEGIES,
    direction: 'long',
    marginAsset: 'collateral',
    subject: COLLATERAL,
    quote: DEBT,
    marginAmount: 1n * 10n ** 18n,
    sizedBy: 'supply',
    supplyAmount: 2n * 10n ** 18n,
    borrowAmount: 0n,
    maxSupply: 10n * 10n ** 18n,
    slippageBps: 50n,
    marginBalance: 100n * 10n ** 18n,
    existingCollateralUsd: 0n,
    existingDebtUsd: 0n,
    existingLtvBps: 0n,
    existingLiquidationThresholdBps: 0n,
    collateralEnablement: null,
    reserves: {
      collateral: {
        address: COLLATERAL, symbol: 'WETH', decimals: 18, priceUsd: 300_000_000_000n,
        ltvBps: 8000n, liquidationThresholdBps: 8300n,
      },
      debt: {
        address: DEBT, symbol: 'USDC', decimals: 6, priceUsd: 100_000_000n,
        ltvBps: 7700n, liquidationThresholdBps: 8000n,
      },
    },
    ...over,
  }
}

const signTypedData = vi.fn<(payload: unknown) => Promise<typeof SIGNATURE>>(async () => SIGNATURE)
/** Typed with its argument, so assertions can read WHICH call a write was. */
const writeContract = vi.fn<(args: { functionName: string }) => Promise<`0x${string}`>>(
  async () => `0x${'11'.repeat(32)}`,
)

/**
 * This repo's jsdom exposes no `localStorage` at all, so one is installed here.
 *
 * `browserStorage()` is the only thing in the hook that touches the global, and it treats an
 * absent store as "nothing held" — which every one of these assertions would then pass through
 * vacuously. Installing a real store is what makes the caching observable.
 */
function installStorage() {
  const map = new Map<string, string>()
  const store = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  }
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true })
  return store
}

type Hook = ReturnType<typeof useLeverageOpen>

/** The live hook value, so assertions can read state and call `execute` directly. */
let result: { current: Hook }
const hook = () => result.current

/** Lets the debounce, the quote and the build settle into a preview. */
async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })
  }
}

async function mount(input: LeverageOpenInput = makeInput()) {
  result = renderHook(() => useLeverageOpen(input, { signTypedData, writeContract })).result
  await settle()
}

/** The prerequisites: approve and delegate. What the panel's Open button now does on its own. */
async function prepare() {
  await act(async () => {
    await hook().prepare()
  })
}

/** The send, which is all the modal's Confirm is left holding. */
async function submit() {
  await act(async () => {
    await hook().submit()
  })
}

/**
 * Both halves, with the pricing gap between them that the real flow always has.
 *
 * Banking a signature pins the borrow, and the pin is folded into the quoting effect's key — so
 * the preview it was taken against is stale the moment it lands, and `submit` has nothing to send
 * until a route priced AT the signed figure arrives. The modal shows that gap as "Pricing…" with
 * Confirm disabled; here it is a settle.
 */
async function confirm() {
  await prepare()
  await settle()
  await submit()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  installStorage()
  debtPerCollateral = 3000n
  mocks.usePublicClient.mockReturnValue({
    // The only direct read `execute` makes: the margin allowance, already covering it.
    readContract: vi.fn(async () => 10n ** 30n),
  })
  mocks.useChainId.mockReturnValue(CHAIN_ID)
  mocks.useConnection.mockReturnValue({ address: OWNER })
  mocks.useWriteContract.mockReturnValue({ writeContractAsync: vi.fn() })
  mocks.useSignTypedData.mockReturnValue({ signTypedDataAsync: vi.fn() })
  mocks.getPauseState.mockResolvedValue({ paused: false })
  mocks.getAllowedRouters.mockResolvedValue([ROUTER])
  mocks.getAdaptersForChain.mockReturnValue([fakeAdapter()])
  mocks.getPoolDataProvider.mockResolvedValue('0x0000000000000000000000000000000000000123')
  mocks.getReserveTokens.mockResolvedValue({ vDebt: V_DEBT })
  // No standing delegation, so every attempt needs a signature unless one is held.
  mocks.getDelegationAllowance.mockResolvedValue(0n)
  mocks.getPermitContext.mockResolvedValue({ name: 'Aave Variable Debt USDC', nonce: NONCE })
  signTypedData.mockResolvedValue(SIGNATURE)
  writeContract.mockResolvedValue(`0x${'11'.repeat(32)}`)
})

it('banks the signature it takes, over exactly the borrow being opened', async () => {
  await mount()
  expect(hook().preview).not.toBeNull()
  const borrow = hook().preview!.borrowAmount

  await confirm()

  expect(signTypedData).toHaveBeenCalledTimes(1)
  // Cleared on submit — the transaction is spending this nonce, so nothing may be built against
  // it a second time.
  expect(loadDelegation(localStorage, KEY)).toBeNull()
  // What it signed is what the position borrows: a delegation over any other figure would not
  // recover the signer inside `delegationWithSig`.
  const signed = signTypedData.mock.calls[0][0] as { message: { value: bigint } }
  expect(signed.message.value).toBe(borrow)
})

it('spends the same signature on a retry after the send fails', async () => {
  // The failure this whole change exists for: a stale route reverts, and the second press used to
  // cost another wallet prompt on top.
  writeContract.mockRejectedValueOnce(new Error('execution reverted'))
  await mount()
  const borrow = hook().preview!.borrowAmount
  await confirm()

  expect(hook().step).toBe('error')
  expect(signTypedData).toHaveBeenCalledTimes(1)
  expect(loadDelegation(localStorage, KEY)?.value).toBe(borrow)

  // The failed attempt re-quoted, and `execute` refuses a preview it has already invalidated —
  // so the retry has to wait for the fresh route, exactly as the modal does.
  await settle()
  await confirm()

  expect(signTypedData).toHaveBeenCalledTimes(1)
  expect(writeContract).toHaveBeenCalledTimes(2)
})

it('pins the quoted borrow to a signature already in storage', async () => {
  // Without pinning, the retry re-solves the borrow, lands a wei or two away, and invalidates the
  // very signature being preserved.
  await mount()
  const solved = hook().preview!.borrowAmount
  const pinned = solved + 1n

  localStorage.setItem(KEY, JSON.stringify({
    chainId: CHAIN_ID, owner: OWNER, debtAsset: DEBT, debtToken: V_DEBT, delegatee: STRATEGIES,
    nonce: NONCE.toString(), value: pinned.toString(),
    deadline: (BigInt(Math.floor(Date.now() / 1000)) + 1800n).toString(), signature: SIGNATURE,
  }))

  await mount()

  expect(hook().pinnedBorrow).toBe(pinned)
  expect(hook().preview?.borrowAmount).toBe(pinned)
  expect(hook().reusableSignature?.value).toBe(pinned)

  await confirm()
  expect(signTypedData).not.toHaveBeenCalled()
})

it('re-signs once the nonce shows the delegation was spent', async () => {
  writeContract.mockRejectedValueOnce(new Error('execution reverted'))
  await mount()
  await confirm()
  expect(signTypedData).toHaveBeenCalledTimes(1)

  // Another transaction consumed the grant, so the held signature is worthless whatever its
  // deadline says.
  mocks.getPermitContext.mockResolvedValue({ name: 'Aave Variable Debt USDC', nonce: NONCE + 1n })
  await settle()
  await confirm()

  expect(signTypedData).toHaveBeenCalledTimes(2)
})

it('ignores a signature with too little validity left to survive inclusion', async () => {
  localStorage.setItem(KEY, JSON.stringify({
    chainId: CHAIN_ID, owner: OWNER, debtAsset: DEBT, debtToken: V_DEBT, delegatee: STRATEGIES,
    nonce: NONCE.toString(), value: '1',
    deadline: (BigInt(Math.floor(Date.now() / 1000)) + MIN_DELEGATION_REMAINING_S).toString(),
    signature: SIGNATURE,
  }))

  await mount()

  // Not pinned, so the borrow is solved freely — and confirming takes a fresh signature rather
  // than one that would expire between here and the block.
  expect(hook().pinnedBorrow).toBeNull()
  expect(hook().reusableSignature).toBeNull()

  await confirm()
  expect(signTypedData).toHaveBeenCalledTimes(1)
})

it('does not adopt a signature whose borrow is far from what this form would open', async () => {
  // Held from a much smaller position. Adopting it would open the OLD size rather than the typed
  // one, since reuse pins the borrow.
  localStorage.setItem(KEY, JSON.stringify({
    chainId: CHAIN_ID, owner: OWNER, debtAsset: DEBT, debtToken: V_DEBT, delegatee: STRATEGIES,
    nonce: NONCE.toString(), value: (10n * 10n ** 6n).toString(),
    deadline: (BigInt(Math.floor(Date.now() / 1000)) + 1800n).toString(), signature: SIGNATURE,
  }))

  await mount()

  expect(hook().pinnedBorrow).toBeNull()
  expect(hook().preview!.borrowAmount).toBeGreaterThan(100n * 10n ** 6n)
})

it('skips the wallet entirely when a standing delegation already covers the borrow', async () => {
  mocks.getDelegationAllowance.mockResolvedValue(10n ** 30n)
  await mount()
  await confirm()

  expect(signTypedData).not.toHaveBeenCalled()
  expect(writeContract).toHaveBeenCalled()
})

it('prepare takes the approve and the signature, and sends nothing', async () => {
  // The gate the split exists for: the wallet work is done, the position is not opened, and the
  // user still gets a look at what they are about to submit.
  mocks.usePublicClient.mockReturnValue({ readContract: vi.fn(async () => 0n) })
  await mount()
  const borrow = hook().preview!.borrowAmount

  await prepare()

  expect(hook().step).toBe('ready')
  expect(signTypedData).toHaveBeenCalledTimes(1)
  // One write, and it is the approve — not the open.
  expect(writeContract).toHaveBeenCalledTimes(1)
  expect(writeContract.mock.calls[0][0]).toMatchObject({ functionName: 'approve' })
  expect(hook().txHash).toBeUndefined()
  // Banked, because everything after this point may fail and must not cost a second prompt.
  expect(loadDelegation(localStorage, KEY)?.value).toBe(borrow)
})

it('submit spends what prepare took, with no second prompt', async () => {
  await mount()
  await prepare()
  expect(signTypedData).toHaveBeenCalledTimes(1)

  // The pinned re-quote the modal waits on before Confirm is pressable.
  await settle()
  await submit()

  expect(hook().step).toBe('done')
  expect(signTypedData).toHaveBeenCalledTimes(1)
  expect(writeContract).toHaveBeenCalledTimes(1) // allowance already covers it, so send only
  expect(loadDelegation(localStorage, KEY)).toBeNull()
})

it('submit does nothing until prepare has run', async () => {
  // Nothing is authorised yet, so a send here would revert on the delegation check and cost gas.
  await mount()
  await submit()

  expect(writeContract).not.toHaveBeenCalled()
  expect(hook().step).toBe('idle')
})

it('a rejected signature leaves nothing prepared and nothing sent', async () => {
  signTypedData.mockRejectedValueOnce(new Error('User rejected the request'))
  await mount()

  await prepare()

  expect(hook().step).toBe('error')
  expect(writeContract).not.toHaveBeenCalled()
  expect(loadDelegation(localStorage, KEY)).toBeNull()
})

it('refuses to submit a route whose borrow has left the signature behind', async () => {
  // The signature authorises ONE exact figure (AaveV3Strategies.sol:287,343). Sending against a
  // preview that has moved off it burns gas on a revert the hook can see coming. Reachable
  // whenever the pin lapses while the modal is open — a signature timing out does exactly that.
  await mount()
  await prepare()
  const signedFor = loadDelegation(localStorage, KEY)!.value

  // The pin lapses, and the market moves, so the free re-solve lands somewhere else.
  await act(async () => {
    hook().forgetSignature()
  })
  debtPerCollateral = 3300n
  await settle()
  expect(hook().preview!.borrowAmount).not.toBe(signedFor)

  await submit()

  expect(writeContract).not.toHaveBeenCalled()
  expect(hook().step).toBe('error')
})

it('forgetSignature drops the pin so the borrow sizes itself again', async () => {
  await mount()
  const solved = hook().preview!.borrowAmount

  localStorage.setItem(KEY, JSON.stringify({
    chainId: CHAIN_ID, owner: OWNER, debtAsset: DEBT, debtToken: V_DEBT, delegatee: STRATEGIES,
    nonce: NONCE.toString(), value: (solved + 1n).toString(),
    deadline: (BigInt(Math.floor(Date.now() / 1000)) + 1800n).toString(), signature: SIGNATURE,
  }))
  await mount()
  expect(hook().pinnedBorrow).toBe(solved + 1n)

  await act(async () => {
    hook().forgetSignature()
  })
  await settle()

  expect(hook().pinnedBorrow).toBeNull()
  expect(loadDelegation(localStorage, KEY)).toBeNull()
  expect(hook().preview!.borrowAmount).toBe(solved)
})
