import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ limitedFetch: vi.fn() }))

vi.mock('./http', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  limitedFetch: mocks.limitedFetch,
}))

import { simulateSwap, swapSimulationInput, SIMULATION_GAS } from './simulate'

const INPUT = {
  chainId: 8453,
  from: '0x253FaC550bae1EE9B4680b3735DC38a3f6eCd600',
  to: '0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d',
  spender: '0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d',
  data: '0x3f0bde25',
  tokenIn: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amountIn: '967883000000',
  tokenOut: '0x4200000000000000000000000000000000000006',
}

const respond = (body: unknown, ok = true, status = 200) =>
  mocks.limitedFetch.mockResolvedValue({ ok, status, json: async () => body })

/** The body the module actually posted, parsed. */
const sentBody = () => JSON.parse(mocks.limitedFetch.mock.calls[0][1].body)

describe('simulateSwap', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports the measured output and gas', async () => {
    respond({ success: true, amountOut: '394118357000000000000', gasUsed: 5141427 })

    const result = await simulateSwap(INPUT)

    expect(result).toEqual({
      ok: true,
      amountOut: 394118357000000000000n,
      gasUsed: 5141427,
    })
  })

  it('asks for a gas limit high enough that a large route does not run out', async () => {
    // The endpoint defaults to half the block gas limit, under which every route above roughly
    // 400k USDC returns `Call failed` at ~14.1M gas — indistinguishable from a real revert.
    // Measured: the same route that "reverts" on the default succeeds at 60M, using 33.9M.
    respond({ success: true, amountOut: '1', gasUsed: 1 })

    await simulateSwap(INPUT)

    expect(sentBody().gas).toBe(String(SIMULATION_GAS))
    expect(SIMULATION_GAS).toBeGreaterThan(33_900_000)
  })

  it('addresses the simulation to the chain the swap is on', async () => {
    respond({ success: true, amountOut: '1', gasUsed: 1 })

    await simulateSwap({ ...INPUT, chainId: 42161 })

    expect(mocks.limitedFetch.mock.calls[0][0]).toContain('/simulate/42161')
  })

  it('passes the approval target separately from the call target', async () => {
    // They are equal for every adapter the leverage flows can execute, but the endpoint
    // defaults `spender` to `to`, so sending it explicitly is what keeps a future adapter with
    // a separate approval proxy from being simulated against the wrong allowance.
    respond({ success: true, amountOut: '1', gasUsed: 1 })

    await simulateSwap({ ...INPUT, spender: '0x1111111111111111111111111111111111111111' })

    expect(sentBody().spender).toBe('0x1111111111111111111111111111111111111111')
  })

  it('reports a reverting route as run-and-failed, with the reason', async () => {
    respond({
      success: false,
      amountOut: '0',
      gasUsed: 54210,
      revertReason: 'Insufficient output',
    })

    const result = await simulateSwap(INPUT)

    expect(result).toEqual({
      ok: false,
      amountOut: 0n,
      gasUsed: 54210,
      revertReason: 'Insufficient output',
    })
  })

  it('returns null when the simulator itself is unreachable', async () => {
    // Distinct from a reverting route: the caller falls back to the built amount here, and
    // must not be able to read this as evidence about the route.
    mocks.limitedFetch.mockRejectedValue(new Error('network down'))

    expect(await simulateSwap(INPUT)).toBeNull()
  })

  it('returns null when the simulator answers with an error status', async () => {
    respond({ error: 'rpc node failed' }, false, 502)

    expect(await simulateSwap(INPUT)).toBeNull()
  })

  it('returns null when the response carries no output field to read', async () => {
    respond({ success: true, gasUsed: 100 })

    expect(await simulateSwap(INPUT)).toBeNull()
  })
})


describe('swapSimulationInput', () => {
  const tx = {
    to: '0xRouter', spender: '0xSpender', data: '0xdead', value: '0', amountOut: '1',
  } as never

  it('measures the swap the contract makes, from the contract, at the quoted size', () => {
    // Each of these has a plausible wrong answer that still returns a number: the user's wallet
    // instead of the contract, the position's assets instead of the swap's, or the size the
    // position was sized to instead of the size this quote was priced at.
    expect(
      swapSimulationInput({
        chainId: 8453,
        caller: '0xContract',
        tokenIn: '0xDebt',
        tokenOut: '0xCollateral',
        amountIn: '400000000000',
        tx,
      }),
    ).toEqual({
      chainId: 8453,
      from: '0xContract',
      to: '0xRouter',
      spender: '0xSpender',
      data: '0xdead',
      tokenIn: '0xDebt',
      tokenOut: '0xCollateral',
      amountIn: '400000000000',
    })
  })
})
