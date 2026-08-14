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
import { swappedLog, transferLog, ZERO_ADDRESS } from '../test/receiptLogs'

const ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'
const STRATEGIES = '0x000000000000000000000000000000000000bEEF' as Address
const OWNER = '0x000000000000000000000000000000000000dEaD' as Address
const COLLATERAL = '0x1111111111111111111111111111111111111111' as Address
const DEBT = '0x4444444444444444444444444444444444444444' as Address
const V_DEBT = '0x5555555555555555555555555555555555555555' as Address
const CHAIN_ID = 8453

const mocks = vi.hoisted(() => ({
  clearQuoteCache: vi.fn(),
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
// Partial: `AggregatorHttpError` has to stay the real class — the throttling tests branch on
// `instanceof` — while the cache drop needs to be observable.
vi.mock('../adapters/http', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  clearQuoteCache: mocks.clearQuoteCache,
}))
vi.mock('wagmi', () => ({
  usePublicClient: mocks.usePublicClient,
  useChainId: mocks.useChainId,
  useConnection: mocks.useConnection,
  useWriteContract: mocks.useWriteContract,
  useSignTypedData: mocks.useSignTypedData,
}))

import { AggregatorHttpError } from '../adapters/http'
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

/** The collateral's aToken and the pair's variable-debt token, as the receipt names them. */
const A_COLLATERAL = '0x00000000000000000000000000000000000000a1' as Address

let waitForTransactionReceipt: ReturnType<typeof vi.fn>

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

/** Re-renders the mounted hook with new inputs, the way the panel does when the form changes. */
let repriceWith: (input: LeverageOpenInput) => void = () => {}

async function mount(input: LeverageOpenInput = makeInput()) {
  const rendered = renderHook(
    (props: LeverageOpenInput) => useLeverageOpen(props, { signTypedData, writeContract }),
    { initialProps: input },
  )
  result = rendered.result
  repriceWith = rendered.rerender
  await settle()
}

/** A change to the form on the SAME mount — which is where a stale preview can survive. */
async function reprice(input: LeverageOpenInput) {
  await act(async () => {
    repriceWith(input)
  })
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
  waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: 'success', logs: [] })
  mocks.usePublicClient.mockReturnValue({
    // The only direct read `execute` makes: the margin allowance, already covering it.
    readContract: vi.fn(async () => 10n ** 30n),
    waitForTransactionReceipt,
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

it('reads the settled swap and the wallet changes off the open receipt', async () => {
  await mount()
  await prepare()
  await settle()

  // What the route promised, captured before the send re-prices it.
  const expectedOut = hook().preview!.expectedOut
  const borrowed = hook().preview!.borrowAmount
  const filled = expectedOut - 10n ** 15n // the price moved a thousandth of a token in flight
  waitForTransactionReceipt.mockResolvedValue({
    status: 'success',
    logs: [
      transferLog(COLLATERAL, OWNER, STRATEGIES, 1n * 10n ** 18n),
      swappedLog({
        router: ROUTER as Address,
        srcToken: DEBT,
        dstToken: COLLATERAL,
        dstReceiver: STRATEGIES,
        spentAmount: borrowed,
        returnAmount: filled,
      }),
      transferLog(A_COLLATERAL, ZERO_ADDRESS, OWNER, 3n * 10n ** 18n),
      transferLog(V_DEBT, ZERO_ADDRESS, OWNER, borrowed),
    ],
  })

  await submit()

  expect(hook().outcome?.swap?.spentAmount).toBe(borrowed)
  expect(hook().outcome?.fill?.delta).toBe(-(10n ** 15n))
  expect(hook().outcome?.deltas).toEqual([
    { token: COLLATERAL, delta: -(1n * 10n ** 18n) },
    { token: A_COLLATERAL, delta: 3n * 10n ** 18n },
    { token: V_DEBT, delta: borrowed },
  ])
})

it('reports the open as sent even when the receipt never arrives', async () => {
  // The transaction IS submitted. A receipt that times out says nothing about whether it landed,
  // and turning that into a failure would send the user to re-open a position they may hold.
  waitForTransactionReceipt.mockRejectedValue(new Error('timed out'))
  await mount()
  await confirm()

  expect(hook().step).toBe('done')
  expect(hook().txHash).toBeDefined()
  expect(hook().outcome).toBeNull()
  expect(hook().execError).toBeNull()
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

it('separates an aggregator that is refusing to answer from a pair that has no route', async () => {
  // Being rate-limited is not the same as there being no liquidity, and telling the user the
  // latter sends them looking for the wrong problem. KyberSwap is the only compatible adapter,
  // so one 429 takes the whole flow down.
  const adapter = fakeAdapter()
  adapter.getQuote = vi.fn(async () => {
    throw new AggregatorHttpError(429, 'https://aggregator-api.kyberswap.com/base/api/v1/routes')
  })
  mocks.getAdaptersForChain.mockReturnValue([adapter])

  await mount()

  expect(hook().preview).toBeNull()
  expect(hook().previewError).toBe('AGGREGATOR_UNAVAILABLE')
})

it('still says NO_ROUTE when the aggregator answers and simply has nothing', async () => {
  const adapter = fakeAdapter()
  adapter.getQuote = vi.fn(async () => null)
  mocks.getAdaptersForChain.mockReturnValue([adapter])

  await mount()

  expect(hook().previewError).toBe('NO_ROUTE')
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

it('derives the floor from the tolerance, so editing it re-prices what the contract enforces', async () => {
  // The claim the confirm modal's slippage control rests on: changing the tolerance does not
  // adjust `minOut` in the UI, it re-quotes and the floor falls out of the route that comes back.
  const floorFor = (p: { expectedOut: bigint; flashAmount: bigint }, bps: bigint) => {
    const guaranteed = (p.expectedOut * (10000n - bps)) / 10000n
    // Never below the flash repayment: that floor is the contract's, not the router's.
    return guaranteed > p.flashAmount ? guaranteed : p.flashAmount
  }

  await mount(makeInput({ slippageBps: 50n }))
  const tight = hook().preview!
  expect(tight.minOut).toBe(floorFor(tight, 50n))

  await mount(makeInput({ slippageBps: 200n }))
  const wide = hook().preview!
  expect(wide.minOut).toBe(floorFor(wide, 200n))

  // A wider tolerance needs a bigger borrow to still guarantee repaying the same flash loan.
  expect(wide.borrowAmount).toBeGreaterThan(tight.borrowAmount)
})

it('keeps the pin when only the tolerance changes, so re-pricing costs no signature', async () => {
  // Editing slippage is the user re-pricing the position they already signed for, not re-sizing
  // it. Judging the band at the NEW tolerance moved the seed by roughly the edit itself — 2% to
  // 0.1% moves it ~1.9%, past the 1% band — and dropped a pin nobody asked to drop.
  await mount(makeInput({ slippageBps: 200n }))
  await prepare()
  await settle()
  const signed = hook().reusableSignature!.value

  await mount(makeInput({ slippageBps: 10n }))

  expect(hook().pinnedBorrow).toBe(signed)
  expect(hook().preview!.borrowAmount).toBe(signed)
  expect(hook().reusableSignature?.value).toBe(signed)
})

it('offers a re-sign rather than silently re-sizing when the new tolerance outruns the signed borrow', async () => {
  // The one case the maths genuinely requires a new signature: the borrow was solved so the
  // guarantee just clears the flash loan, so widening leaves it short. Holding the pin is what
  // turns that into an explicit "re-sign at the new size" — dropping it re-solved the borrow
  // behind the user's back, and the coverage check then refused the send after they pressed it.
  await mount(makeInput({ slippageBps: 10n }))
  await prepare()
  await settle()
  const signed = hook().reusableSignature!.value

  await mount(makeInput({ slippageBps: 200n }))

  expect(hook().pinnedBorrow).toBe(signed)
  expect(hook().previewError).toBe('QUOTE_MOVED')
})

it('re-prices from the network when the user asks for a newer price', async () => {
  // The panel quotes once per change to the form and then stops. An explicit refresh has to beat
  // the 4s reuse window too — otherwise pressing it inside that window returns the same numbers
  // the user pressed it to get away from.
  const adapter = fakeAdapter()
  mocks.getAdaptersForChain.mockReturnValue([adapter])
  await mount()
  const quotedBefore = vi.mocked(adapter.getQuote).mock.calls.length

  await act(async () => {
    hook().hardRefresh()
  })
  await settle()

  expect(vi.mocked(adapter.getQuote).mock.calls.length).toBeGreaterThan(quotedBefore)
  expect(mocks.clearQuoteCache).toHaveBeenCalled()
})

it('reports an open the chain reverted as an error, not as done', async () => {
  // The receipt is in hand by this point. Reading its status is the difference between telling
  // someone they hold a position and telling them the transaction was thrown away.
  waitForTransactionReceipt.mockResolvedValue({ status: 'reverted', logs: [] })
  await mount()
  await confirm()

  expect(hook().step).toBe('error')
  expect(hook().execError).toMatch(/revert/i)
  // Still the one thing worth having: where to go and look at it.
  expect(hook().txHash).toBeDefined()
})

it('drops a receipt that arrives after its attempt has been abandoned', async () => {
  // The await outlives `submit`. A slow receipt landing after the user has started a second open
  // would otherwise fill THIS attempt's panel with the last one's numbers — and, since the
  // history is filed by whatever hash is current, record the new hash against the old swap.
  let land: (r: unknown) => void = () => {}
  waitForTransactionReceipt.mockReturnValue(
    new Promise((resolve) => {
      land = resolve
    }),
  )
  await mount()
  await prepare()
  await settle()

  // Started, not awaited: the receipt is still in flight while the user moves on.
  let sending: Promise<void> = Promise.resolve()
  await act(async () => {
    sending = hook().submit()
  })
  act(() => {
    hook().reset()
  })
  await act(async () => {
    land({ status: 'success', logs: [transferLog(COLLATERAL, OWNER, STRATEGIES, 1n)] })
    await sending
  })

  expect(hook().outcome).toBeNull()
})

it('clears the route a failed re-quote replaces, so nothing stale can be confirmed', async () => {
  // The effect only sets a preview on success, but it used to mark EVERY run as the answer for
  // its inputs — so a failed re-quote left the previous route looking current, and Confirm would
  // send calldata built for inputs the user had already changed.
  await mount(makeInput({ slippageBps: 10n }))
  await prepare()
  await settle()
  expect(hook().preview).not.toBeNull()

  await reprice(makeInput({ slippageBps: 200n }))

  expect(hook().previewError).toBe('QUOTE_MOVED')
  expect(hook().preview).toBeNull()
})

