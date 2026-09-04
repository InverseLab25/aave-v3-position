import { describe, it, expect, vi } from 'vitest'
import {
  pinnedGasLimit,
  gasFromMeasuredSwap,
  GasEstimateError,
  GAS_LIMIT_BUFFER_PERCENT,
  STRATEGY_OVERHEAD_GAS,
} from './gas'

/** The rejection, typed. `.catch(e => e)` widens to include the resolved value. */
async function rejection(p: Promise<unknown>): Promise<GasEstimateError> {
  try {
    await p
  } catch (e) {
    return e as GasEstimateError
  }
  throw new Error('expected a rejection')
}

describe('pinnedGasLimit', () => {
  it('buffers the estimate the same way the old inline code did', async () => {
    const gas = await pinnedGasLimit(async () => 100_000n, { label: 'close' })
    expect(gas).toBe((100_000n * GAS_LIMIT_BUFFER_PERCENT) / 100n)
  })

  it('throws instead of falling back to the wallet when the estimate fails', async () => {
    // The old behaviour was `catch { gas = undefined }`, which handed the limit to the wallet's
    // own unbuffered guess. On a flash-loan transaction that is how you get an out-of-gas
    // revert that costs real money, so a failed estimate now stops the send.
    const boom = vi.fn().mockRejectedValue(new Error('rpc exploded'))
    await expect(pinnedGasLimit(boom, { label: 'close' })).rejects.toBeInstanceOf(GasEstimateError)
    await expect(pinnedGasLimit(boom, { label: 'close' })).rejects.toThrow(/close/)
  })

  it('keeps the underlying failure as the cause, so the reason is not lost', async () => {
    const cause = new Error('execution reverted: NoDebt()')
    const err = await rejection(pinnedGasLimit(async () => { throw cause }, { label: 'close' }))
    expect(err.cause).toBe(cause)
  })

  it('clamps to the cap when the buffer is what pushed it over', async () => {
    // 15,500,000 fits on its own; buffered it is 17,050,000, which Base rejects outright with
    // "gas limit too high". Clamping still leaves 1,277,216 of headroom over the estimate, so
    // the transaction can run — it just gets less margin than the buffer asked for.
    expect(await pinnedGasLimit(async () => 15_500_000n, { chainId: 8453, label: 'flip' }))
      .toBe(16_777_216n)
  })

  it('aborts when the estimate ALONE is above the cap', async () => {
    // Nothing to clamp to here: the cap is below what the call is measured to need, so any
    // limit we could legally send runs out of gas mid-execution and burns the fee for nothing.
    await expect(pinnedGasLimit(async () => 17_000_000n, { chainId: 8453, label: 'flip' }))
      .rejects.toThrow(/cap/i)
  })

  it('flags an over-cap failure apart from an estimate failure', async () => {
    // The two need different words: one is retryable, the other needs a different route.
    const over = await rejection(pinnedGasLimit(async () => 17_000_000n, { chainId: 8453 }))
    const failed = await rejection(
      pinnedGasLimit(async () => { throw new Error('rpc') }, { chainId: 8453 }),
    )
    expect(over.overCap).toBe(true)
    expect(failed.overCap).toBe(false)
  })

  it('leaves the full buffer alone on a chain with no cap', async () => {
    // Arbitrum takes 40,000,000 in one transaction, so nothing clamps.
    expect(await pinnedGasLimit(async () => 15_500_000n, { chainId: 42161 })).toBe(23_250_000n)
  })

  it('does not clamp when the chain is unknown', async () => {
    expect(await pinnedGasLimit(async () => 15_500_000n, { chainId: 999999 })).toBe(23_250_000n)
  })
})

describe('gasFromMeasuredSwap', () => {
  it('adds the strategy overhead to what the simulator measured', () => {
    expect(gasFromMeasuredSwap(2_600_000n)).toBe(2_600_000n + STRATEGY_OVERHEAD_GAS)
  })

  it('does NOT buffer on top, unlike an estimate', () => {
    // The buffer exists because an estimate is a guess against state that may move. This is a
    // measurement plus an allowance already several times the real overhead — padding it again
    // would send limits far past what a wallet shows without alarm.
    expect(gasFromMeasuredSwap(2_600_000n)).toBeLessThan(
      (2_600_000n * GAS_LIMIT_BUFFER_PERCENT) / 100n + STRATEGY_OVERHEAD_GAS,
    )
  })

  it('refuses rather than pinning a limit the chain will not accept', () => {
    // Base caps a transaction at 2^24. A limit above it is rejected by the node before any funds
    // check, so there is no transaction worth sending — and it is not retryable, which `overCap`
    // is what tells the caller.
    let thrown: unknown
    try {
      gasFromMeasuredSwap(16_000_000n, { chainId: 8453, label: 'open' })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(GasEstimateError)
    expect((thrown as GasEstimateError).overCap).toBe(true)
    expect((thrown as Error).message).toContain('open:')
  })

  it('leaves an uncapped chain alone', () => {
    expect(gasFromMeasuredSwap(30_000_000n, { chainId: 999_999 })).toBe(
      30_000_000n + STRATEGY_OVERHEAD_GAS,
    )
  })
})
