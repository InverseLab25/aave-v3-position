import { describe, it, expect } from 'vitest'
import { swapSimulationInput } from './simulate'

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
