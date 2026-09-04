import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Address, Hex } from 'viem'
import { TxReport } from './TxReport'
import type { TxOutcome } from '../lib/txOutcome'

const WETH = '0x4200000000000000000000000000000000000006' as Address
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const HASH = `0x${'11'.repeat(32)}` as Hex

const outcome: TxOutcome = {
  swap: {
    router: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' as Address,
    sender: WETH,
    srcToken: USDC,
    dstToken: WETH,
    dstReceiver: WETH,
    spentAmount: 1_899_171_711n,
    returnAmount: 1_003_307_090_025_359_338n,
  },
  fill: { delta: 0n, percent: 0, belowFloor: false, basis: 'simulated' as const },
  deltas: [],
}

const tokens = {
  [WETH.toLowerCase()]: { symbol: 'WETH', decimals: 18 },
  [USDC.toLowerCase()]: { symbol: 'USDC', decimals: 6 },
}

const steps = [
  { label: 'signed', done: true },
  { label: 'send', done: false, active: true },
]

describe('TxReport', () => {
  it('states progress, then what settled, then where to look', () => {
    // The order is the point: both transaction screens had these four in this sequence, and
    // keeping them in one component is what stops the two drifting apart again.
    const { container } = render(
      <TxReport steps={steps} outcome={outcome} outcomeTokens={tokens} txHash={HASH} chainId={8453} />,
    )

    expect(screen.getByRole('status').textContent).toBe('✓ signed · send')
    expect(screen.getByText('Settled')).toBeTruthy()
    expect(container.querySelector('a[href*="basescan"]')).toBeTruthy()
  })

  it('shows a failure as a failure, with its remedy', () => {
    render(
      <TxReport
        steps={steps}
        error="Slippage exceeded"
        errorHint="Try again with a wider tolerance."
        outcome={null}
        outcomeTokens={{}}
        txHash={undefined}
        chainId={8453}
      />,
    )

    expect(screen.getByText(/Slippage exceeded/)).toBeTruthy()
    expect(screen.getByText(/wider tolerance/)).toBeTruthy()
  })

  it('distinguishes a note from a failure', () => {
    // A submitted transaction whose receipt never arrived is not a failed transaction, and showing
    // it in the error channel would send a user to redo something they may already hold.
    const { container } = render(
      <TxReport
        steps={steps}
        note="No receipt after 5 minutes. It may still land."
        outcome={null}
        outcomeTokens={{}}
        txHash={HASH}
        chainId={8453}
      />,
    )

    expect(screen.getByText(/No receipt after 5 minutes/)).toBeTruthy()
    expect(container.querySelector('.alert-danger')).toBeNull()
  })

  it('says nothing about a receipt there is no hash for', () => {
    const { container } = render(
      <TxReport steps={steps} outcome={null} outcomeTokens={{}} txHash={undefined} chainId={8453} />,
    )

    expect(container.querySelector('a')).toBeNull()
    expect(screen.queryByText('Settled')).toBeNull()
  })

  it('holds its shape for a flow with no steps to show', () => {
    // The same-asset close runs a plain pool call: no permits, no swap, nothing to enumerate.
    render(
      <TxReport steps={[]} outcome={outcome} outcomeTokens={tokens} txHash={HASH} chainId={8453} />,
    )

    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('Settled')).toBeTruthy()
  })
})
