import { expect, it } from 'vitest'
import { toFunctionSelector } from 'viem'
import { decodeStrategiesError } from './strategiesErrors'

/** viem surfaces a revert with the raw error data hung off the error chain. */
function revertWith(signature: string) {
  return { cause: { data: toFunctionSelector(signature) } }
}

it('maps a router shortfall to widening slippage', () => {
  const failure = decodeStrategiesError(revertWith('InsufficientOutputFromRouter()'))
  expect(failure?.error).toBe('InsufficientOutputFromRouter')
  expect(failure?.remedy).toBe('widen-slippage')
})

it('maps a flash-repayment shortfall to re-quoting, NOT to widening slippage', () => {
  // The swap cleared minOut; the borrow was undersized because the rate moved. Telling the
  // user to raise their slippage here would be wrong advice.
  const failure = decodeStrategiesError(revertWith('InsufficientOutputForFlashLoanRepayment()'))
  expect(failure?.error).toBe('InsufficientOutputForFlashLoanRepayment')
  expect(failure?.remedy).toBe('requote')
})

it('maps owner config changes to a refresh', () => {
  expect(decodeStrategiesError(revertWith('Paused()'))?.remedy).toBe('refresh')
  expect(decodeStrategiesError(revertWith('RouterNotAllowed()'))?.remedy).toBe('refresh')
})

it('maps caller-side mistakes to no remedy', () => {
  expect(decodeStrategiesError(revertWith('ZeroAmount()'))?.remedy).toBe('none')
})

it('returns null for anything that is not a Strategies revert', () => {
  expect(decodeStrategiesError(new Error('user rejected the request'))).toBeNull()
  expect(decodeStrategiesError(revertWith('SomeOtherError()'))).toBeNull()
  expect(decodeStrategiesError(undefined)).toBeNull()
})

it('gives every mapped error a non-empty human message', () => {
  for (const sig of [
    'InsufficientOutputFromRouter()',
    'InsufficientOutputForFlashLoanRepayment()',
    'Paused()',
    'RouterNotAllowed()',
    'ZeroAmount()',
  ]) {
    expect(decodeStrategiesError(revertWith(sig))?.message.length).toBeGreaterThan(0)
  }
})
