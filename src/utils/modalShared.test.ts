import { describe, it, expect } from 'vitest'
import { parseUnits } from 'viem'
import { healthFactor, evaluateHf, HF_BLOCK, HF_WARN } from './health'
import {
  maxNativeSpendable,
  nativeGasReserve,
  MIN_GAS_RESERVE_WEI,
  GAS_RESERVE_MULTIPLE,
} from './maxAmount'
import { calculateAdjustedFees, bufferedGasLimit, GAS_LIMIT_BUFFER_PERCENT } from './gas'

/**
 * The pure core behind all four Aave action modals — BorrowRepay, Withdraw, AssetsToSupply and
 * AssetsToBorrow each import the same three helpers, and none of them was covered.
 *
 * These decide the health factor a user acts on, the amount a MAX button sends, and the fees a
 * transaction is signed with. Testing them once is worth more than four shallow render suites,
 * because a defect here is wrong in every modal at once.
 */

describe('healthFactor', () => {
  it('is weighted collateral over debt', () => {
    expect(healthFactor(30_000, 20_000)).toBe('1.50')
  })

  it('reports no debt as infinite rather than dividing by zero', () => {
    expect(healthFactor(30_000, 0)).toBe('∞')
  })

  it('treats a dust debt as no debt', () => {
    // Below a tenth of a cent the ratio explodes into a meaningless number; the threshold is
    // what stops "your health factor is 30,000,000" appearing on a fully repaid position.
    expect(healthFactor(30_000, 0.0005)).toBe('∞')
  })

  it('caps an absurd ratio at infinite', () => {
    expect(healthFactor(30_000, 1)).toBe('∞')
  })

  it('keeps two decimals just below the cap', () => {
    expect(healthFactor(100, 1)).toBe('100.00')
  })
})

describe('evaluateHf', () => {
  it('blocks below the safety floor', () => {
    const v = evaluateHf(1.02)
    expect(v.level).toBe('block')
    expect(v.message).toContain('1.02')
  })

  it('warns between the floor and the comfort line', () => {
    expect(evaluateHf(1.2).level).toBe('warn')
  })

  it('passes at or above the comfort line', () => {
    expect(evaluateHf(HF_WARN).level).toBe('ok')
    expect(evaluateHf(3).level).toBe('ok')
  })

  it('treats the floor itself as acceptable, not blocked', () => {
    // The boundary is `< HF_BLOCK`, so exactly 1.03 must pass — an off-by-one here silently
    // refuses a transaction the contract would accept.
    expect(evaluateHf(HF_BLOCK).level).toBe('warn')
    expect(evaluateHf(HF_BLOCK - 0.0001).level).toBe('block')
  })

  it("accepts the '∞' string healthFactor returns, and calls it ok", () => {
    // A first supply has no debt, so its projected HF is ∞. Blocking that would refuse every
    // opening deposit.
    expect(evaluateHf('∞').level).toBe('ok')
  })

  it('parses a numeric string', () => {
    expect(evaluateHf('1.01').level).toBe('block')
    expect(evaluateHf('2.00').level).toBe('ok')
  })

  it('falls back to ok on unusable input rather than blocking on missing data', () => {
    // Deliberate: an unavailable HF should fall through to the on-chain simulate-then-write
    // revert, not lock the user out of the modal.
    expect(evaluateHf(Number.NaN).level).toBe('ok')
    expect(evaluateHf('').level).toBe('ok')
    expect(evaluateHf('not a number').level).toBe('ok')
  })
})

describe('nativeGasReserve', () => {
  it('falls back to the floor before a fee estimate has resolved', () => {
    // The user can click MAX on the first render, before useEstimateFeesPerGas returns.
    expect(nativeGasReserve(undefined, 300_000n)).toBe(MIN_GAS_RESERVE_WEI)
  })

  it('doubles the estimate, because the fee is re-read at signing time', () => {
    const maxFee = 30_000_000_000n // 30 gwei
    const gasLimit = 300_000n
    expect(nativeGasReserve(maxFee, gasLimit)).toBe(maxFee * gasLimit * GAS_RESERVE_MULTIPLE)
  })

  it('keeps the floor when a real estimate comes in under it', () => {
    // An L2 fee estimate is far below the floor; taking it literally would leave a wallet
    // unable to pay for the transaction it just sized.
    expect(nativeGasReserve(1n, 21_000n)).toBe(MIN_GAS_RESERVE_WEI)
  })
})

describe('maxNativeSpendable', () => {
  it('holds gas back, because the amount is sent as msg.value', () => {
    const balance = parseUnits('1', 18)
    const maxFee = 30_000_000_000n
    const gasLimit = 300_000n

    expect(maxNativeSpendable(balance, maxFee, gasLimit)).toBe(
      balance - maxFee * gasLimit * GAS_RESERVE_MULTIPLE,
    )
  })

  it('floors at zero rather than underflowing on a dust balance', () => {
    // bigint subtraction would wrap into an astronomically large amount and be sent as value.
    expect(maxNativeSpendable(1n, undefined, 300_000n)).toBe(0n)
  })

  it('returns zero when the balance exactly equals the reserve', () => {
    expect(maxNativeSpendable(MIN_GAS_RESERVE_WEI, undefined, 300_000n)).toBe(0n)
  })

  it('stays exact on a balance a double could not represent', () => {
    // The whole reason this takes a bigint: Number(formatUnits(raw, 18)) round-trips through a
    // lossy double and drifts in both directions, and an overshoot is sent as more than you own.
    const awkward = 1_234_567_890_123_456_789n
    expect(maxNativeSpendable(awkward, undefined, 300_000n)).toBe(awkward - MIN_GAS_RESERVE_WEI)
  })
})

describe('bufferedGasLimit', () => {
  it('adds the safety buffer to a raw estimate', () => {
    expect(bufferedGasLimit(100_000n)).toBe((100_000n * GAS_LIMIT_BUFFER_PERCENT) / 100n)
  })

  it('always returns at least the estimate', () => {
    // Unused gas is refunded, so the buffer is free — but going UNDER the estimate would
    // guarantee an out-of-gas revert.
    for (const g of [1n, 21_000n, 900_000n, 5_000_000n]) {
      expect(bufferedGasLimit(g)).toBeGreaterThanOrEqual(g)
    }
  })
})

describe('calculateAdjustedFees', () => {
  const BASE_FEE_BUFFER = 24_000_000_000n
  const PRIORITY = 1_000_000_000n
  const MAX_FEE = BASE_FEE_BUFFER + PRIORITY

  it('scales the priority fee and preserves the EIP-1559 invariant', () => {
    // maxFeePerGas must stay >= baseFee + priority. Deriving the buffer by subtraction rather
    // than guessing viem's multiplier is what makes that hold by construction.
    const { adjustedMaxFeePerGas, adjustedMaxPriorityFeePerGas } = calculateAdjustedFees(
      MAX_FEE,
      PRIORITY,
      10n,
    )

    expect(adjustedMaxPriorityFeePerGas).toBe(PRIORITY * 10n)
    expect(adjustedMaxFeePerGas).toBe(BASE_FEE_BUFFER + PRIORITY * 10n)
    expect(adjustedMaxFeePerGas!).toBeGreaterThanOrEqual(adjustedMaxPriorityFeePerGas!)
  })

  it('is a no-op at a multiplier of one', () => {
    const { adjustedMaxFeePerGas, adjustedMaxPriorityFeePerGas } = calculateAdjustedFees(
      MAX_FEE,
      PRIORITY,
    )

    expect(adjustedMaxFeePerGas).toBe(MAX_FEE)
    expect(adjustedMaxPriorityFeePerGas).toBe(PRIORITY)
  })

  it('bumps a legacy gasPrice by 20% only when priority is requested', () => {
    const gasPrice = 10_000_000_000n

    expect(calculateAdjustedFees(undefined, undefined, 10n, gasPrice).adjustedGasPrice).toBe(
      (gasPrice * 12n) / 10n,
    )
    // Multiplying an entire legacy gas price by 10 would be a massive overpayment.
    expect(calculateAdjustedFees(undefined, undefined, 1n, gasPrice).adjustedGasPrice).toBe(gasPrice)
  })

  it('never returns both fee shapes at once', () => {
    // viem's fee parameters are a union — EIP-1559 OR legacy. Passing all three falls outside
    // every member of it and the request is rejected.
    const eip1559 = calculateAdjustedFees(MAX_FEE, PRIORITY, 2n)
    expect(eip1559.adjustedGasPrice).toBeUndefined()

    const legacy = calculateAdjustedFees(undefined, undefined, 2n, 10_000_000_000n)
    expect(legacy.adjustedMaxFeePerGas).toBeUndefined()
    expect(legacy.adjustedMaxPriorityFeePerGas).toBeUndefined()
  })

  it('returns nothing usable when no estimate resolved at all', () => {
    const none = calculateAdjustedFees(undefined, undefined, 2n, undefined)
    expect(none.adjustedMaxFeePerGas).toBeUndefined()
    expect(none.adjustedGasPrice).toBeUndefined()
  })

  it('prefers the EIP-1559 pair when a chain reports both', () => {
    // Some RPCs return gasPrice alongside the 1559 fields; taking the legacy branch there would
    // drop the priority scaling entirely.
    const both = calculateAdjustedFees(MAX_FEE, PRIORITY, 5n, 10_000_000_000n)
    expect(both.adjustedMaxFeePerGas).toBe(BASE_FEE_BUFFER + PRIORITY * 5n)
    expect(both.adjustedGasPrice).toBeUndefined()
  })
})
