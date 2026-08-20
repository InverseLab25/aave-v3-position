import { describe, expect, it } from 'vitest'
import { positionHashes } from './aaveTxHashes'
import type { HistoryItem } from './aaveUserHistory'

const row = (__typename: string, txHash?: string): HistoryItem => ({ __typename, txHash })

const supply = (txHash: string) => row('UserSupplyTransaction', txHash)
const borrow = (txHash: string) => row('UserBorrowTransaction', txHash)
const withdraw = (txHash: string) => row('UserWithdrawTransaction', txHash)
const repay = (txHash: string) => row('UserRepayTransaction', txHash)

describe('positionHashes', () => {
  it('collapses one transaction reported several times into one hash', () => {
    // A leveraged open is a supply, a borrow and a second supply — three rows, one receipt to read.
    expect(positionHashes([supply('0xaa'), borrow('0xaa'), supply('0xbb')])).toEqual(['0xaa', '0xbb'])
  })

  it('matches duplicates across casing', () => {
    // Aave's indexer and an RPC do not agree on the casing of a hash, and a miss here is a
    // permanent one-per-load refetch rather than a wrong answer.
    expect(positionHashes([supply('0xAA'), borrow('0xaa')])).toEqual(['0xAA'])
  })

  it('keeps the movements a close appears as, not just an open', () => {
    // Verified against a real Base account: its close showed up as a Repay and NOTHING else, so a
    // list narrowed to supply and borrow found two of its three positions and silently lost the
    // one that would have reset the cost basis.
    expect(positionHashes([withdraw('0xaa'), repay('0xbb')])).toEqual(['0xaa', '0xbb'])
  })

  it('drops movements that can never be ours', () => {
    // A standalone collateral toggle and somebody else's liquidation both screen out, so reading
    // their receipts was a request with a guaranteed negative verdict. The shared query has to ask
    // for liquidations because the cost-basis replay realizes P&L against them — this filter is
    // what stops that costing discovery anything.
    const items = [
      supply('0xaa'),
      row('UserLiquidationCallTransaction'),
      row('UserUsageAsCollateralTransaction', '0xcc'),
    ]

    expect(positionHashes(items)).toEqual(['0xaa'])
  })

  it('ignores a row the indexer returned without a hash', () => {
    expect(positionHashes([row('UserSupplyTransaction'), supply('0xaa')])).toEqual(['0xaa'])
  })

  it('has nothing to say about a wallet with no Aave history', () => {
    expect(positionHashes([])).toEqual([])
  })
})
