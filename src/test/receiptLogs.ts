/**
 * Receipt log builders, shared by everything that reads a transaction back off its own logs.
 *
 * Hand-written hex is the usual way these fixtures go wrong — a word in the wrong place decodes
 * into a plausible number rather than an error, and the test then asserts the bug. Encoding them
 * through viem means a fixture is wrong only if the ABI is.
 */
import { encodeAbiParameters, pad, parseAbiParameters, type Address, type Hex } from 'viem'
import { AGGREGATED_TRADE_TOPIC, SWAPPED_TOPIC } from '../lib/txOutcome'

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

interface FixtureLog {
  address: Address
  topics: Hex[]
  data: Hex
}

/** The router's `Swapped`, with every argument non-indexed as the routers emit it. */
export function swappedLog(o: {
  router: Address
  sender?: Address
  srcToken: Address
  dstToken: Address
  dstReceiver: Address
  spentAmount: bigint
  returnAmount: bigint
}): FixtureLog {
  return {
    address: o.router,
    topics: [SWAPPED_TOPIC],
    data: encodeAbiParameters(
      parseAbiParameters('address, address, address, address, uint256, uint256'),
      [
        o.sender ?? o.router,
        o.srcToken,
        o.dstToken,
        o.dstReceiver,
        o.spentAmount,
        o.returnAmount,
      ],
    ),
  }
}

/** An ERC20 `Transfer`: both parties indexed, the amount in data. */
export function transferLog(
  token: Address,
  from: Address,
  to: Address,
  value: bigint,
): FixtureLog {
  return {
    address: token,
    topics: [TRANSFER_TOPIC, pad(from, { size: 32 }), pad(to, { size: 32 })],
    data: encodeAbiParameters(parseAbiParameters('uint256'), [value]),
  }
}

/**
 * Nordstern's `AggregatedTrade`, which its Guard emits instead of `Swapped`.
 *
 * Two arguments are indexed, so they live in topics rather than data — the shape hand-written
 * hex gets wrong most often. Encoded through viem for the same reason the others are.
 */
export function aggregatedTradeLog(o: {
  guard: Address
  id?: number
  user: Address
  tokenIn: Address
  tokenOut: Address
  executor?: Address
  amountIn: bigint
  amountOut: bigint
  minAmountOut?: bigint
}): FixtureLog {
  return {
    address: o.guard,
    topics: [
      AGGREGATED_TRADE_TOPIC,
      pad(`0x${(o.id ?? 0xf853).toString(16)}` as Hex, { size: 32 }),
      pad(o.user, { size: 32 }),
    ],
    data: encodeAbiParameters(
      parseAbiParameters('address, address, address, uint256, uint256, uint256'),
      [
        o.tokenIn,
        o.tokenOut,
        o.executor ?? o.guard,
        o.amountIn,
        o.amountOut,
        o.minAmountOut ?? o.amountOut,
      ],
    ),
  }
}
