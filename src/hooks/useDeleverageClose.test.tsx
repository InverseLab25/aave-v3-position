import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { parseUnits, WaitForTransactionReceiptTimeoutError } from 'viem'

/**
 * `buildPlan` is where every close is validated before a signature is ever requested, and it was
 * the largest untested surface in the app. These drive it through `preview()`, which is the same
 * function `close()` runs — so a gate proven here is a gate `close()` inherits.
 *
 * Everything below the hook is mocked: wagmi, the memoised Aave statics, the adapter registry
 * and `sizeSwap`. That keeps these about the hook's own decisions rather than about routing
 * math, which `sizing.test.ts` and `closePlan.test.ts` already cover.
 */
const mocks = vi.hoisted(() => ({
  useConnection: vi.fn(),
  useChainId: vi.fn(),
  usePublicClient: vi.fn(),
  useWalletClient: vi.fn(),
  useConfig: vi.fn(),
  getChainConfig: vi.fn(),
  getStrategiesAddress: vi.fn(),
  getPoolDataProvider: vi.fn(),
  getReserveTokens: vi.fn(),
  getATokenName: vi.fn(),
  getAdaptersForChain: vi.fn(),
  sizeSwap: vi.fn(),
  oracleSeed: vi.fn(),
  readContract: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useConnection: mocks.useConnection,
  useChainId: mocks.useChainId,
  usePublicClient: mocks.usePublicClient,
  useWalletClient: mocks.useWalletClient,
  useConfig: mocks.useConfig,
}))
vi.mock('wagmi/actions', () => ({
  estimateFeesPerGas: vi.fn(),
  simulateContract: vi.fn(),
}))
vi.mock('../config/chains', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getChainConfig: mocks.getChainConfig,
  getStrategiesAddress: mocks.getStrategiesAddress,
}))
vi.mock('../lib/aaveStatics', () => ({
  getPoolDataProvider: mocks.getPoolDataProvider,
  getReserveTokens: mocks.getReserveTokens,
  getATokenName: mocks.getATokenName,
}))
vi.mock('../adapters', () => ({ getAdaptersForChain: mocks.getAdaptersForChain }))
// Partial: `AggregatorHttpError` has to be the real class, because the hook branches on
// `instanceof` to tell a throttled aggregator from a pair with no route.
vi.mock('../adapters/http', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  clearQuoteCache: vi.fn(),
  fetchQuoteJson: vi.fn(),
}))
vi.mock('../lib/sizing', () => ({ sizeSwap: mocks.sizeSwap, oracleSeed: mocks.oracleSeed }))
// Partial, deliberately: only `selectRoute` reaches the network (it builds router calldata).
// planWithdrawal, reuseBlocker, computeMinOut and assertExecutable stay real, because those
// ARE the decisions under test — mocking them would hollow the suite out.
vi.mock('../lib/closePlan', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  selectRoute: vi.fn(),
}))

import { AggregatorHttpError } from '../adapters/http'
import { RECEIPT_TIMEOUT_MS, useDeleverageClose } from './useDeleverageClose'

const USER = '0x1111111111111111111111111111111111111111' as const
const DELEVERAGER = '0x2222222222222222222222222222222222222222' as const
const ATOKEN = '0x3333333333333333333333333333333333333333' as const
const VDEBT = '0x4444444444444444444444444444444444444444' as const
const ROUTER = '0x5555555555555555555555555555555555555555' as const

const WETH = {
  underlyingAsset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  symbol: 'WETH',
  decimals: 18,
  priceInUsd: '3000',
} as const
const USDC = {
  underlyingAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  symbol: 'USDC',
  decimals: 6,
  priceInUsd: '1',
} as const

/** 10 WETH supplied against 20,000 USDC of debt — comfortably covered. */
const COLL_AMOUNT = parseUnits('10', 18)
const DEBT = parseUnits('20000', 6)

/** What `sizeSwap` hands back once it has converged. Swapping 7 WETH clears the debt. */
const SIZED = {
  requiredIn: parseUnits('7', 18),
  expectedOut: parseUnits('21000', 6),
  minDebtOut: parseUnits('20900', 6),
  covered: true,
  guaranteed: true,
  best: {
    aggregator: 'KyberSwap',
    amountIn: parseUnits('7', 18).toString(),
    amountOut: parseUnits('21000', 6).toString(),
    rawAmountInUsd: '21000',
    rawAmountOutUsd: '20990',
    gasEstimate: '450000',
  },
  ranked: [],
}

/** Reads are keyed by function, and the two `balanceOf` calls by which token they hit. */
const defaultReads = ({
  paused = 0n,
  routers = [ROUTER] as readonly string[],
  debt = DEBT,
  collAmount = COLL_AMOUNT,
} = {}) =>
  vi.fn(async ({ address, functionName }: { address: string; functionName: string }) => {
    switch (functionName) {
      case 'paused':
        return paused
      case 'getAllowedRouters':
        return routers
      case 'nonces':
        return 7n
      case 'balanceOf':
        return address === ATOKEN ? collAmount : debt
      default:
        throw new Error(`unmocked read: ${functionName}`)
    }
  })

const baseInput = { collateral: WETH, debtAsset: USDC, slippagePercent: 0.5 }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useConnection.mockReturnValue({ address: USER })
  mocks.useChainId.mockReturnValue(1)
  mocks.useWalletClient.mockReturnValue({ data: { signTypedData: vi.fn() } })
  mocks.useConfig.mockReturnValue({})
  mocks.usePublicClient.mockReturnValue({ readContract: defaultReads() })
  mocks.getStrategiesAddress.mockReturnValue(DELEVERAGER)
  mocks.getChainConfig.mockReturnValue({
    name: 'Ethereum',
    aave: { poolAddressesProvider: '0x6666666666666666666666666666666666666666' },
    adapters: ['KyberSwap'],
  })
  mocks.getPoolDataProvider.mockResolvedValue('0x7777777777777777777777777777777777777777')
  mocks.getReserveTokens.mockResolvedValue({ aToken: ATOKEN, vDebt: VDEBT })
  mocks.getATokenName.mockResolvedValue('Aave Ethereum WETH')
  mocks.getAdaptersForChain.mockReturnValue([{ name: 'KyberSwap', getQuote: vi.fn() }])
  mocks.oracleSeed.mockReturnValue(parseUnits('7', 18))
  mocks.sizeSwap.mockResolvedValue(SIZED)
})

const previewWith = async (overrides: Record<string, unknown> = {}) => {
  const { result } = renderHook(() => useDeleverageClose())
  return result.current.preview({ ...baseInput, ...overrides })
}

describe('buildPlan — validation before any signature is requested', () => {
  it('produces a preview describing the swap on the happy path', async () => {
    const { preview, error } = await previewWith()

    expect(error).toBeNull()
    expect(preview?.covered).toBe(true)
    expect(preview?.guaranteed).toBe(true)
    expect(preview?.aggregator).toBe('KyberSwap')
    // 10 supplied, 7 swapped — the remaining 3 are never withdrawn.
    expect(preview?.collateralSwapped).toBe('7')
    expect(preview?.collateralKeptSupplied).toBe('3')
    // Surplus beyond the debt is what the contract forwards to the wallet.
    expect(preview?.debtReturned).toBe('1000')
  })

  /** Makes the mocked `sizeSwap` actually exercise the hook's `quoteAt`. */
  const sizeSwapCallingQuoteAt = () =>
    mocks.sizeSwap.mockImplementation(async ({ quoteAt }: { quoteAt: (n: bigint) => Promise<unknown[]> }) => {
      await quoteAt(parseUnits('7', 18))
      return SIZED
    })

  it('names a throttled aggregator rather than blaming the pair', async () => {
    // The close used to swallow every quote failure into null, so being rate-limited arrived as
    // "this pair cannot be closed" — which is both wrong and unactionable.
    mocks.getAdaptersForChain.mockReturnValue([
      {
        name: 'KyberSwap',
        getQuote: vi.fn().mockRejectedValue(new AggregatorHttpError(429, 'https://kyber/routes')),
      },
    ])
    sizeSwapCallingQuoteAt()

    const { preview, error } = await previewWith()

    expect(preview).toBeNull()
    expect(error?.kind).toBe('aggregator')
    expect(error?.message).toMatch(/rate-limiting|down/i)
  })

  it('leaves an answered-but-empty quote to the ordinary no-route path', async () => {
    // A refusal is not a verdict on the pair; an actual empty answer is.
    mocks.getAdaptersForChain.mockReturnValue([
      { name: 'KyberSwap', getQuote: vi.fn().mockResolvedValue(null) },
    ])
    let ranked: unknown[] | null = null
    mocks.sizeSwap.mockImplementation(async ({ quoteAt }: { quoteAt: (n: bigint) => Promise<unknown[]> }) => {
      ranked = await quoteAt(parseUnits('7', 18))
      return SIZED
    })

    const { error } = await previewWith()

    expect(ranked).toEqual([])
    expect(error).toBeNull() // no throw from quoteAt — sizeSwap is what judges an empty ranking
  })

  it('proceeds when one adapter is throttled but another still prices it', async () => {
    mocks.getAdaptersForChain.mockReturnValue([
      {
        name: 'OpenOcean',
        getQuote: vi.fn().mockRejectedValue(new AggregatorHttpError(503, 'https://oo/quote')),
      },
      { name: 'KyberSwap', getQuote: vi.fn().mockResolvedValue(quote(SIZED.expectedOut)) },
    ])
    sizeSwapCallingQuoteAt()

    const { error } = await previewWith()

    expect(error).toBeNull()
  })

  it('rejects a NaN slippage instead of dying in BigInt()', async () => {
    // Math.round(NaN) is NaN, and NaN fails BOTH the < 0 and >= 10000 comparisons, so before
    // the isFinite guard this sailed through and threw a RangeError from BigInt(10000 - NaN)
    // — surfacing as an opaque failure rather than this message.
    const { error } = await previewWith({ slippagePercent: Number.NaN })

    expect(error?.kind).toBe('pair')
    expect(error?.message).toContain('Slippage must be between 0% and 100%')
  })

  it.each([[-1], [100], [150]])('rejects out-of-range slippage: %s%%', async (slippagePercent) => {
    const { error } = await previewWith({ slippagePercent })
    expect(error?.message).toContain('Slippage must be between 0% and 100%')
  })

  it('rejects an explicit collateralIn above the supplied balance', async () => {
    // planWithdrawal caps the PULL at the balance but not the swap size, so this used to size a
    // swap larger than the withdrawal funding it and surface as a negative "kept supplied".
    const { error } = await previewWith({ collateralIn: parseUnits('11', 18) })

    expect(error?.kind).toBe('pair')
    expect(error?.message).toContain('10 WETH supplied')
  })

  it('accepts an explicit collateralIn exactly at the balance', async () => {
    // The boundary is inclusive — asking for everything you have is a drain, not a typo.
    const { error } = await previewWith({ collateralIn: COLL_AMOUNT })
    expect(error).toBeNull()
  })

  it("accepts the 'all' sentinel, which resolves on-chain rather than through this check", async () => {
    const { error } = await previewWith({ collateralIn: 'all' })
    expect(error).toBeNull()
    expect(mocks.sizeSwap).toHaveBeenCalledWith(expect.objectContaining({ fixedIn: COLL_AMOUNT }))
  })

  it('refuses when the contract is paused', async () => {
    mocks.usePublicClient.mockReturnValue({ readContract: defaultReads({ paused: 1n }) })
    const { error } = await previewWith()

    expect(error?.kind).toBe('deployment')
    expect(error?.message).toContain('paused')
  })

  it('refuses when no router is allowlisted', async () => {
    // An empty allowlist cannot produce an executable route, so failing here beats discovering
    // it after the user has signed.
    mocks.usePublicClient.mockReturnValue({ readContract: defaultReads({ routers: [] }) })
    const { error } = await previewWith()

    expect(error?.kind).toBe('deployment')
    expect(error?.message).toContain('No swap routers are allowlisted')
  })

  it('refuses when there is no debt to close', async () => {
    mocks.usePublicClient.mockReturnValue({ readContract: defaultReads({ debt: 0n }) })
    const { error } = await previewWith()
    expect(error?.message).toContain('No debt to close')
  })

  it('refuses when there is no collateral to withdraw', async () => {
    mocks.usePublicClient.mockReturnValue({ readContract: defaultReads({ collAmount: 0n }) })
    const { error } = await previewWith()
    expect(error?.message).toContain('No collateral to withdraw')
  })

  it('refuses a native-ETH sentinel, which is not an Aave reserve', async () => {
    const { error } = await previewWith({
      collateral: { ...WETH, underlyingAsset: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' },
    })

    expect(error?.kind).toBe('pair')
    expect(error?.message).toContain('Native ETH is not an Aave reserve')
  })

  it('refuses on a chain with no deployment', async () => {
    mocks.getStrategiesAddress.mockReturnValue(undefined)
    const { error } = await previewWith()

    expect(error?.kind).toBe('deployment')
    expect(error?.message).toContain('not available on this network')
  })

  it('refuses without a connected wallet', async () => {
    mocks.useConnection.mockReturnValue({ address: undefined })
    const { error } = await previewWith()

    expect(error?.kind).toBe('wallet')
  })

  it('sizes against the debt PLUS an accrual buffer, not the bare debt', async () => {
    // Interest accrues between the quote and inclusion; sizing to the bare debt would land the
    // swap short of it. The buffer is 0.5%.
    await previewWith()

    expect(mocks.sizeSwap).toHaveBeenCalledWith(
      expect.objectContaining({ debt: DEBT, needed: (DEBT * 10050n) / 10000n }),
    )
  })

  it('passes the slippage complement through as slipNum', async () => {
    await previewWith({ slippagePercent: 1 })
    expect(mocks.sizeSwap).toHaveBeenCalledWith(expect.objectContaining({ slipNum: 9900n }))
  })
})

/*//////////////////////////////////////////////////////////////
                      EXECUTION: close()
//////////////////////////////////////////////////////////////*/

/**
 * A syntactically valid 65-byte signature. `parseSignature` is real here — the permits are the
 * subject of these tests, so faking the parse would hollow them out.
 */
const SIG = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b` as const

/** Ranked-quote shape `rankRoutes` will keep: the aggregator must be in COMPATIBLE_ADAPTERS. */
const quote = (amountOut: bigint) => ({
  aggregator: 'KyberSwap',
  amountIn: parseUnits('7', 18).toString(),
  amountOut: amountOut.toString(),
  netReturnUsd: 21000,
  rawAmountInUsd: '21000',
  rawAmountOutUsd: '20990',
})

const route = (builtOut: bigint) => ({
  router: ROUTER,
  swapData: '0xdeadbeef',
  chosen: quote(builtOut),
  tx: { to: ROUTER, data: '0xdeadbeef', value: '0', spender: ROUTER, amountOut: builtOut.toString() },
  rejected: [],
})

describe('close() — signatures, reuse and the degradation baseline', () => {
  let signTypedData: ReturnType<typeof vi.fn>
  let writeContract: ReturnType<typeof vi.fn>
  let waitForTransactionReceipt: ReturnType<typeof vi.fn>
  let selectRoute: ReturnType<typeof vi.fn>
  let simulateContract: ReturnType<typeof vi.fn>
  /** Mutable: the hook captures publicClient at render, so a test that needs the nonce to
   *  move mid-flight has to change it through this rather than by re-mocking the hook. */
  let nonce = 7n

  beforeEach(async () => {
    signTypedData = vi.fn().mockResolvedValue(SIG)
    writeContract = vi.fn().mockResolvedValue('0xhash')
    waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: 'success' })

    mocks.useWalletClient.mockReturnValue({ data: { signTypedData, writeContract } })
    nonce = 7n
    mocks.usePublicClient.mockReturnValue({
      readContract: vi.fn(async ({ address, functionName }: { address: string; functionName: string }) => {
        if (functionName === 'nonces') return nonce
        if (functionName === 'paused') return 0n
        if (functionName === 'getAllowedRouters') return [ROUTER]
        if (functionName === 'balanceOf') return address === ATOKEN ? COLL_AMOUNT : DEBT
        throw new Error(`unmocked read: ${functionName}`)
      }),
      waitForTransactionReceipt,
      estimateContractGas: vi.fn().mockResolvedValue(900_000n),
    })
    // The single adapter behind the real `quoteAt`, so buildFreshRoute re-quotes for real.
    mocks.getAdaptersForChain.mockReturnValue([
      { name: 'KyberSwap', getQuote: vi.fn().mockResolvedValue(quote(SIZED.expectedOut)) },
    ])

    selectRoute = vi.mocked((await import('../lib/closePlan')).selectRoute)
    selectRoute.mockResolvedValue(route(SIZED.expectedOut))

    const actions = await import('wagmi/actions')
    vi.mocked(actions.estimateFeesPerGas).mockResolvedValue({
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      gasPrice: 30_000_000_000n,
    } as never)
    simulateContract = vi.mocked(actions.simulateContract)
    simulateContract.mockResolvedValue({ request: { to: DELEVERAGER } } as never)
  })

  const mount = () => renderHook(() => useDeleverageClose()).result

  it('first press banks the signatures and submits nothing', async () => {
    // The whole point of stopping here: the user gets the numbers back to review, and the
    // second press executes with no wallet dialog in between. That gap used to be where the
    // router's output floor went stale.
    const r = mount()
    const out = await r.current.close(baseInput)

    expect(out.status).toBe('signed')
    expect(out.hash).toBeNull()
    // Grant + revoke, at sequential nonces.
    expect(signTypedData).toHaveBeenCalledTimes(2)
    expect(writeContract).not.toHaveBeenCalled()
    expect(out.signatureExpiresAt).toBeGreaterThan(0)
  })

  it('second press reuses the held signatures and submits without a new prompt', async () => {
    const r = mount()
    await r.current.close(baseInput)
    signTypedData.mockClear()

    const out = await r.current.close(baseInput)

    expect(signTypedData).not.toHaveBeenCalled()
    expect(writeContract).toHaveBeenCalledTimes(1)
    expect(out.status).toBe('success')
    expect(out.hash).toBe('0xhash')
  })

  it('clears the held signatures once the close lands — the nonce is spent', async () => {
    const r = mount()
    await r.current.close(baseInput)
    await r.current.close(baseInput)
    signTypedData.mockClear()

    // A third close has nothing to reuse, so it must ask again.
    const out = await r.current.close(baseInput)
    expect(signTypedData).toHaveBeenCalledTimes(2)
    expect(out.status).toBe('signed')
  })

  it('keeps the held signatures when the transaction reverts — that nonce was not spent', async () => {
    const r = mount()
    await r.current.close(baseInput)
    waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' })

    const reverted = await r.current.close(baseInput)
    expect(reverted.status).toBe('reverted')

    // Still reusable: a revert leaves the aToken nonce untouched.
    signTypedData.mockClear()
    waitForTransactionReceipt.mockResolvedValue({ status: 'success' })
    const retry = await r.current.close(baseInput)

    expect(signTypedData).not.toHaveBeenCalled()
    expect(retry.status).toBe('success')
  })

  it('reports a receipt timeout as unresolved, not as a failure, and hands back the hash', async () => {
    // An MEV-protected RPC only includes transactions that would SUCCEED, so a close that would
    // revert is simply never mined and no receipt ever arrives. The hash is the one thing worth
    // returning here — it is how the user checks whether it landed after all.
    const r = mount()
    await r.current.close(baseInput)
    waitForTransactionReceipt.mockRejectedValue(
      new WaitForTransactionReceiptTimeoutError({ hash: '0xhash' }),
    )

    let out!: Awaited<ReturnType<typeof r.current.close>>
    await act(async () => {
      out = await r.current.close(baseInput)
    })

    expect(out.status).toBe('error')
    expect(out.hash).toBe('0xhash')
    expect(r.current.logs.some((l) => /may still land/i.test(l))).toBe(true)
  })

  it('does not claim a five-minute wait when the receipt read failed for another reason', async () => {
    // A bare catch reported an RPC blip three seconds in as "no receipt after 5 minutes", which
    // sends the user off to watch an explorer for a transaction that was never the problem.
    const r = mount()
    await r.current.close(baseInput)
    waitForTransactionReceipt.mockRejectedValue(new Error('HTTP request failed'))

    let out!: Awaited<ReturnType<typeof r.current.close>>
    await act(async () => {
      out = await r.current.close(baseInput)
    })

    expect(out.status).toBe('error')
    // Still the hash: it was submitted, whatever went wrong with reading the receipt.
    expect(out.hash).toBe('0xhash')
    expect(r.current.logs.some((l) => /minutes/i.test(l))).toBe(false)
    expect(r.current.logs.some((l) => /HTTP request failed/.test(l))).toBe(true)
  })

  it('keeps the held signatures when no receipt arrives — that nonce may still be unspent', async () => {
    const r = mount()
    await r.current.close(baseInput)
    waitForTransactionReceipt.mockRejectedValue(
      new WaitForTransactionReceiptTimeoutError({ hash: '0xhash' }),
    )
    await r.current.close(baseInput)

    // Clearing them would force a fresh prompt for a nonce that may never have been consumed.
    // Whether they are still WITHIN their reuse window is a separate question — see the note in
    // ClosePositionModal's failure branch.
    signTypedData.mockClear()
    waitForTransactionReceipt.mockResolvedValue({ status: 'success' })
    const retry = await r.current.close(baseInput)

    expect(signTypedData).not.toHaveBeenCalled()
    expect(retry.status).toBe('success')
  })

  it('still reuses the held signature after a full receipt timeout has elapsed', async () => {
    // The nonce is what decides whether a permit is spent, and a transaction that never landed
    // did not spend it. The permit deadline must therefore outlast the longest wait the flow can
    // impose on itself — a receipt timeout — or every unresolved close re-prompts for a signature
    // that was still perfectly good. It used to: PERMIT_TTL_S was shorter than the timeout.
    const r = mount()
    await r.current.close(baseInput)
    signTypedData.mockClear()

    // Past the whole receipt timeout, plus slack for the re-quote and simulation around it.
    const elapsedMs = RECEIPT_TIMEOUT_MS + 30_000
    const start = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => start + elapsedMs)

    try {
      const out = await r.current.close(baseInput)

      expect(signTypedData).not.toHaveBeenCalled()
      expect(out.status).toBe('success')
    } finally {
      clock.mockRestore()
    }
  })

  it('re-signs when the on-chain nonce has moved under the held signature', async () => {
    const r = mount()
    await r.current.close(baseInput)
    signTypedData.mockClear()

    // Someone consumed the nonce — a front-run, or the user's own earlier attempt landing.
    nonce = 8n

    const out = await r.current.close(baseInput)

    expect(signTypedData).toHaveBeenCalledTimes(2)
    expect(out.status).toBe('signed')
    expect(writeContract).not.toHaveBeenCalled()
  })

  it('clearSignatures drops them, so the next press prompts again', async () => {
    const r = mount()
    await r.current.close(baseInput)
    r.current.clearSignatures()
    signTypedData.mockClear()

    const out = await r.current.close(baseInput)
    expect(signTypedData).toHaveBeenCalledTimes(2)
    expect(out.status).toBe('signed')
  })

  it('measures degradation against the REVIEWED output, not this press re-quote', async () => {
    // The regression F-1 fixed. Press 1 reviews 21,000. While the user reads it the price
    // moves: press 2 re-quotes at 20,520 and the build lands at 20,500.
    //
    //   vs the re-quote (20,520): -0.10%  → inside the 1% tolerance, would submit
    //   vs the reviewed (21,000): -2.38%  → outside it, must not
    //
    // The build still clears the debt-plus-buffer floor (20,500 x 0.995 = 20,397 >= 20,100), so
    // nothing else catches it — which is exactly why this guard exists.
    const r = mount()
    await r.current.close(baseInput)

    const REQUOTED = parseUnits('20520', 6)
    const BUILT = parseUnits('20500', 6)
    mocks.sizeSwap.mockResolvedValue({ ...SIZED, expectedOut: REQUOTED, best: quote(REQUOTED) })
    mocks.getAdaptersForChain.mockReturnValue([
      { name: 'KyberSwap', getQuote: vi.fn().mockResolvedValue(quote(BUILT)) },
    ])
    selectRoute.mockResolvedValue(route(BUILT))

    let out
    await act(async () => {
      out = await r.current.close(baseInput)
    })

    expect(out!.status).toBe('error')
    expect(writeContract).not.toHaveBeenCalled()
    expect(r.current.logs.join(' ')).toContain('worse than the quote you reviewed')
  })

  it('submits when the built route is within tolerance of the reviewed output', async () => {
    // Same shape, 0.5% worse instead of 2.38% — inside the tolerance, so it goes.
    const r = mount()
    await r.current.close(baseInput)

    const BUILT = parseUnits('20900', 6) // 21000 -> 20900 is -0.48%
    mocks.getAdaptersForChain.mockReturnValue([
      { name: 'KyberSwap', getQuote: vi.fn().mockResolvedValue(quote(BUILT)) },
    ])
    selectRoute.mockResolvedValue(route(BUILT))

    const out = await r.current.close(baseInput)

    expect(out.status).toBe('success')
    expect(writeContract).toHaveBeenCalledTimes(1)
  })
})
