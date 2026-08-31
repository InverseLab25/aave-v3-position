import { type Address, type Hex } from 'viem'
import type { Asset } from '../../adapters/types'
import { type FlipSize } from '../../lib/strategies-sdk'

/*//////////////////////////////////////////////////////////////
                             TYPES
//////////////////////////////////////////////////////////////*/

export class FlipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FlipError'
  }
}

export interface FlipInput {
  /** Held as collateral now, owed as debt after. The asset that gets flashed and sold. */
  fromAsset: Asset
  /** Owed now, held as collateral after. */
  toAsset: Asset
  /** Target leverage on the flipped position, bps. 20000n == 2.00x. */
  leverageBps: bigint
  slippagePercent: number
}

export interface FlipPreview extends FlipSize {
  /** The whole aToken balance being given up. */
  collateralAmount: bigint
  /** The whole variable debt being retired. */
  debtAmount: bigint
  router: Address
  swapData: Hex
  /** The chosen route's quoted output, before the user's slippage is applied. */
  quotedOut: bigint
  /**
   * The position this was sized against — the reads `previewFlip` already paid for.
   *
   * Carried so `submitFlip` does not read the whole thing a second time: it needs the aToken,
   * the two names and the two nonces, and asking again is a full extra round of reads for
   * values a preview taken moments earlier already has. It is also the SAME reading the sizing
   * used, which is the reading the signatures have to match.
   */
  position: Position
}

export type FlipStep = 'idle' | 'permit' | 'revoke' | 'delegation' | 'sending' | 'done' | 'error'

/** Everything a flip has to read off chain, gathered once per attempt. */
export interface Position {
  aFrom: Address
  aFromName: string
  vDebtFrom: Address
  vDebtFromName: string
  collateralAmount: bigint
  debtAmount: bigint
  fromPriceUsd: bigint
  toPriceUsd: bigint
  fromDecimals: number
  toDecimals: number
  ltvBps: bigint
  liquidationThresholdBps: bigint
  aTokenNonce: bigint
  delegationNonce: bigint
}
