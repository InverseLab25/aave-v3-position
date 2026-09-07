import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ limitedFetch: vi.fn() }))

vi.mock('./http', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  limitedFetch: mocks.limitedFetch,
}))

// The real map reads `import.meta.env`, which is empty under test, so every chain would answer
// "no endpoint" and every case below would pass for the wrong reason.
vi.mock('../config/rpc', () => ({
  simulationRpc: (chainId: number) =>
    ({ 8453: 'https://base.example/key', 42161: 'https://arbitrum.example/key' })[chainId],
}))

import { simulateSwap, swapSimulationInput, SIMULATION_GAS, clearSlotCache } from './simulate'

const CALLER = '0x253FaC550bae1EE9B4680b3735DC38a3f6eCd600'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const WETH = '0x4200000000000000000000000000000000000006'

const INPUT = {
  chainId: 8453,
  from: CALLER,
  to: '0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d',
  spender: '0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d',
  data: '0x3f0bde25',
  tokenIn: USDC,
  amountIn: '967883000000',
  tokenOut: WETH,
}

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const topic = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0')
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0')

/** One `eth_simulateV1` reply with the destination token landing at `to`. */
const simulated = (out: bigint, gasUsed = 0x1234, to = CALLER) => ({
  result: [
    {
      calls: [
        {
          status: '0x1',
          gasUsed: '0x' + gasUsed.toString(16),
          logs: [{ address: WETH, topics: [TRANSFER, topic(INPUT.to), topic(to)], data: word(out) }],
        },
      ],
    },
  ],
})

const respond = (body: unknown, ok = true, status = 200) =>
  mocks.limitedFetch.mockResolvedValue({ ok, status, json: async () => body })

/** The JSON-RPC payload the module actually posted. */
const sent = (call = 0) => JSON.parse(mocks.limitedFetch.mock.calls[call][1].body)
const params = (call = 0) => sent(call).params[0]

describe('simulateSwap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearSlotCache()
  })

  it('reports the output measured from the destination token transfers', async () => {
    respond(simulated(394118357000000000000n, 5141427))

    expect(await simulateSwap(INPUT)).toEqual({
      ok: true,
      amountOut: 394118357000000000000n,
      gasUsed: 5141427,
    })
  })

  it('takes the LAST transfer of the destination token to the caller, not the first', async () => {
    // Read from the end, the same rule `swapFromTransfers` uses on a receipt, so "what did we
    // receive" means one thing in both readers. Reading from the front would find whatever the
    // route moved through the caller on its way rather than what it settled at.
    //
    // The routers here deliver in one transfer even when the route splits internally — they
    // aggregate first and send once. A router that genuinely paid out in pieces would be
    // under-reported by this, and the `returnData` figure above it is what covers that case.
    respond({
      result: [
        {
          calls: [
            {
              status: '0x1',
              gasUsed: '0x10',
              logs: [
                { address: WETH, topics: [TRANSFER, topic(INPUT.to), topic(CALLER)], data: word(10n) },
                { address: WETH, topics: [TRANSFER, topic(INPUT.to), topic(CALLER)], data: word(17n) },
              ],
            },
          ],
        },
      ],
    })

    expect((await simulateSwap(INPUT))?.amountOut).toBe(17n)
  })

  it('ignores transfers of the destination token to anyone else', async () => {
    // A router taking its fee in the destination token emits a Transfer too, and counting it
    // would report an output the caller never receives.
    respond(simulated(5n, 0x10, '0x1111111111111111111111111111111111111111'))

    expect((await simulateSwap(INPUT))?.amountOut).toBe(0n)
  })

  it('calls eth_simulateV1 on the chain the swap is on', async () => {
    // Base's USDC address is not a known layout on Arbitrum, so this probes first and the
    // simulation is the last call. That the probe also goes to the Arbitrum endpoint is the
    // point: a layout read from the wrong chain would be a layout for a different contract.
    mocks.limitedFetch.mockImplementation(async (_url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () =>
        JSON.parse(init.body as string).method === 'eth_call'
          ? { result: word(10n ** 30n) }
          : simulated(1n),
    }))

    await simulateSwap({ ...INPUT, chainId: 42161 })

    const calls = mocks.limitedFetch.mock.calls
    expect(JSON.parse(calls[calls.length - 1][1].body).method).toBe('eth_simulateV1')
    expect(calls.every((c: unknown[]) => String(c[0]).includes('arbitrum'))).toBe(true)
  })

  it('funds the caller and approves the spender through state overrides', async () => {
    // Without both, the swap reverts on an empty balance or a missing allowance, which reads
    // exactly like a bad route. The spender is overridden separately from the call target
    // because an adapter with a separate approval proxy would otherwise be approved wrongly.
    respond(simulated(1n))

    await simulateSwap({ ...INPUT, spender: '0x1111111111111111111111111111111111111111' })

    const overrides = params().blockStateCalls[0].stateOverrides
    expect(Object.keys(overrides[USDC].stateDiff)).toHaveLength(2)
    expect(overrides[CALLER].balance).toBeDefined()
  })

  it('asks for a gas limit high enough that a large route does not run out', async () => {
    respond(simulated(1n))

    await simulateSwap(INPUT)

    expect(BigInt(params().blockStateCalls[0].calls[0].gas)).toBe(BigInt(SIMULATION_GAS))
    expect(SIMULATION_GAS).toBeGreaterThan(33_900_000)
  })

  it('skips validation so the caller needs no gas of its own', async () => {
    respond(simulated(1n))

    await simulateSwap(INPUT)

    expect(params().validation).toBe(false)
  })

  it('reports a reverting route as run-and-failed, with the reason', async () => {
    respond({
      result: [{ calls: [{ status: '0x0', gasUsed: '0xd3b2', error: { message: 'execution reverted' }, logs: [] }] }],
    })

    expect(await simulateSwap(INPUT)).toEqual({
      ok: false,
      amountOut: 0n,
      gasUsed: 54194,
      revertReason: 'execution reverted',
    })
  })

  it('returns null when the node is unreachable', async () => {
    // Distinct from a reverting route: the caller falls back to the built amount here, and must
    // not be able to read this as evidence about the route.
    mocks.limitedFetch.mockRejectedValue(new Error('network down'))

    expect(await simulateSwap(INPUT)).toBeNull()
  })

  it('returns null when the node answers with an error status', async () => {
    respond({ error: 'gateway' }, false, 502)

    expect(await simulateSwap(INPUT)).toBeNull()
  })

  it('returns null when the node rejects the call', async () => {
    respond({ error: { code: -32601, message: 'method eth_simulateV1 does not exist' } })

    expect(await simulateSwap(INPUT)).toBeNull()
  })

  it('returns null when the response carries no call result to read', async () => {
    respond({ result: [] })

    expect(await simulateSwap(INPUT)).toBeNull()
  })

  it('returns null for a chain it has no endpoint for', async () => {
    expect(await simulateSwap({ ...INPUT, chainId: 999_999 })).toBeNull()
    expect(mocks.limitedFetch).not.toHaveBeenCalled()
  })

  it('does not probe for storage slots it already knows', async () => {
    // Base USDC's layout is recorded, so the only request is the simulation itself. A probe
    // here would be forty extra round trips before every quote.
    respond(simulated(1n))

    await simulateSwap(INPUT)

    expect(mocks.limitedFetch).toHaveBeenCalledTimes(1)
    expect(sent().method).toBe('eth_simulateV1')
  })

  it('probes for an unknown token, then remembers what it found', async () => {
    const unknown = '0x9999999999999999999999999999999999999999'
    // Every probe answers "yes", so slot 0 wins for both the balance and the allowance.
    mocks.limitedFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const method = JSON.parse(init.body as string).method
      return {
        ok: true,
        status: 200,
        json: async () =>
          method === 'eth_call'
            ? { result: word(10n ** 30n) }
            : simulated(3n),
      }
    })

    expect((await simulateSwap({ ...INPUT, tokenIn: unknown }))?.amountOut).toBe(3n)
    const afterFirst = mocks.limitedFetch.mock.calls.length
    expect(afterFirst).toBeGreaterThan(1)

    await simulateSwap({ ...INPUT, tokenIn: unknown })

    // One more call, the simulation. The layout is not looked up twice.
    expect(mocks.limitedFetch.mock.calls.length).toBe(afterFirst + 1)
  })

  it('returns null when a token layout cannot be found', async () => {
    // A wrong override produces a revert on an empty balance, which would read as a bad route.
    // Answering "I could not ask" instead keeps the caller on the aggregator's own figure.
    mocks.limitedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ result: word(0n) }) })

    expect(await simulateSwap({ ...INPUT, tokenIn: '0x8888888888888888888888888888888888888888' })).toBeNull()
  })
})

describe('simulateSwap — the router\'s own account of the same swap', () => {
  const OUT = 1_006_043_087_384_535_296n
  const bare = (n: bigint) => word(n)
  /** Socket's AllowanceHolder wraps its inner call's return as `bytes`: offset, length, word. */
  const wrapped = (n: bigint) => word(32n) + word(32n).slice(2) + word(n).slice(2)

  const withReturn = (out: bigint, returnData: string) => {
    const body = simulated(out)
    ;(body.result[0].calls[0] as { returnData?: string }).returnData = returnData
    return body
  }

  it('says nothing when a bare uint256 agrees with what the transfers moved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    respond(withReturn(OUT, bare(OUT)))

    const r = await simulateSwap(INPUT)

    expect(r?.amountOut).toBe(OUT)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('says nothing when the bytes-wrapped form agrees either', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    respond(withReturn(OUT, wrapped(OUT)))

    await simulateSwap(INPUT)

    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('prefers the returned figure, and warns when the transfers disagree', async () => {
    // A one-word return is indistinguishable from a `bool`, so a router answering `true` reports
    // 1 wei here. The transfers are the check that catches it — loudly, because this number goes
    // on to set `minOut` and the flash-loan size.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    respond(withReturn(OUT, bare(OUT + 1n)))

    const r = await simulateSwap(INPUT)

    expect(r?.amountOut).toBe(OUT + 1n)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('falls back to the transfers for a shape it does not know', async () => {
    // The last 32 bytes of almost any return value parse as a plausible uint256. A decoder that
    // always answered would invent a number for every router it had never seen — and as the
    // PRIMARY source that invention would reach the chain.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    respond(withReturn(OUT, word(1n) + word(2n).slice(2)))

    const r = await simulateSwap(INPUT)

    expect(r?.amountOut).toBe(OUT)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('uses the transfers when the router returned nothing at all', async () => {
    const r = await (respond(simulated(OUT)), simulateSwap(INPUT))

    expect(r?.amountOut).toBe(OUT)
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
