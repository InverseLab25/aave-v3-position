import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import { forgetContractState, readContractState } from './reads'

const STRATEGIES = '0x75B1AB12e47AaEe4E1033100dE1992E735c32C9c' as Address
const ROUTER = '0x50c4E75a512F2A14A7b304787Adf79C4531A5909' as Address

/** A client answering `paused` and `getAllowedRouters`, counting what it was asked. */
function client(paused = 0n, routers: Address[] = [ROUTER]) {
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
    functionName === 'paused' ? paused : routers,
  )
  return { readContract, calls: () => readContract.mock.calls.length }
}

describe('readContractState', () => {
  beforeEach(() => {
    forgetContractState()
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('reads once and answers from the cache after that', async () => {
    // Two RPC reads on every debounce and every three-second re-quote, for values that change
    // when the owner sends a transaction. This is the whole point of the cache.
    const c = client()

    const first = await readContractState(c as never, 8453, STRATEGIES)
    const second = await readContractState(c as never, 8453, STRATEGIES)

    expect(first).toEqual({ paused: false, routers: [ROUTER] })
    expect(second).toBe(first)
    expect(c.calls()).toBe(2)
  })

  it('keys on the chain as well as the address', async () => {
    // AaveV3Strategies is one CREATE3 address on Base and Arbitrum. Keyed on the address alone,
    // one chain would be handed the other's allowlist.
    const c = client()

    await readContractState(c as never, 8453, STRATEGIES)
    await readContractState(c as never, 42161, STRATEGIES)

    expect(c.calls()).toBe(4)
  })

  it('shares one request between runs racing on a cold key', async () => {
    // The promise is cached, not the value, so the second caller joins the first's request
    // rather than issuing its own.
    const c = client()

    await Promise.all([
      readContractState(c as never, 8453, STRATEGIES),
      readContractState(c as never, 8453, STRATEGIES),
    ])

    expect(c.calls()).toBe(2)
  })

  it('re-reads once the entry is older than a minute', async () => {
    const c = client()

    await readContractState(c as never, 8453, STRATEGIES)
    vi.advanceTimersByTime(60_001)
    await readContractState(c as never, 8453, STRATEGIES)

    expect(c.calls()).toBe(4)
  })

  it('drops a failed read so the next run retries instead of replaying the failure', async () => {
    const readContract = vi
      .fn()
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockResolvedValue(0n)
    const c = { readContract }

    await expect(readContractState(c as never, 8453, STRATEGIES)).rejects.toThrow('rpc down')
    // Second attempt is not the cached rejection.
    await expect(readContractState(c as never, 8453, STRATEGIES)).resolves.toBeTruthy()
  })

  it('forgets everything on an explicit refresh', async () => {
    const c = client()

    await readContractState(c as never, 8453, STRATEGIES)
    forgetContractState()
    await readContractState(c as never, 8453, STRATEGIES)

    expect(c.calls()).toBe(4)
  })
})
