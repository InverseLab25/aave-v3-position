import { describe, it, expect } from 'vitest'
import { encodeAbiParameters, parseAbiParameters, pad, type Address, type Hex } from 'viem'
import {
  SWAPPED_TOPIC,
  hideTokens,
  decodeSwaps,
  fillQuality,
  pickSwap,
  readOutcome,
  swapFromTransfers,
  walletDeltas,
} from './txOutcome'
import { aggregatedTradeLog } from '../test/receiptLogs'

const ROUTER: Address = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'
const USER: Address = '0x1111111111111111111111111111111111111111'
const WETH: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

/** A log in the shape a viem receipt carries — only the fields the decoders read. */
interface LogLike {
  address: Address
  topics: [Hex, ...Hex[]] | []
  data: Hex
}

/** The router's `Swapped`, with every argument non-indexed as the routers emit it. */
function swappedLog(o: {
  address?: Address
  sender?: Address
  srcToken: Address
  dstToken: Address
  dstReceiver?: Address
  spentAmount: bigint
  returnAmount: bigint
}): LogLike {
  return {
    address: o.address ?? ROUTER,
    topics: [SWAPPED_TOPIC],
    data: encodeAbiParameters(
      parseAbiParameters('address, address, address, address, uint256, uint256'),
      [
        o.sender ?? ROUTER,
        o.srcToken,
        o.dstToken,
        o.dstReceiver ?? USER,
        o.spentAmount,
        o.returnAmount,
      ],
    ),
  }
}

/** Any log that is not a `Swapped` — an Aave `Supply`, a `Transfer`, whatever else lands. */
const foreignLog = (): LogLike => ({
  address: USDC,
  topics: [pad('0xdead', { size: 32 }), pad(USER, { size: 32 })],
  data: '0x',
})

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO: Address = '0x0000000000000000000000000000000000000000'
const OTHER: Address = '0x2222222222222222222222222222222222222222'
const A_WETH: Address = '0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8'

/** An ERC20 `Transfer`: both parties indexed, the amount in data. */
const transferLog = (token: Address, from: Address, to: Address, value: bigint): LogLike => ({
  address: token,
  topics: [TRANSFER_TOPIC, pad(from, { size: 32 }), pad(to, { size: 32 })],
  data: encodeAbiParameters(parseAbiParameters('uint256'), [value]),
})

describe('decodeSwaps', () => {
  it('decodes a Swapped log into its six arguments', () => {
    const swaps = decodeSwaps([
      swappedLog({ srcToken: WETH, dstToken: USDC, spentAmount: 10n ** 18n, returnAmount: 3405n * 10n ** 6n }),
    ])

    expect(swaps).toEqual([
      {
        router: ROUTER,
        sender: ROUTER,
        srcToken: WETH,
        dstToken: USDC,
        dstReceiver: USER,
        spentAmount: 10n ** 18n,
        returnAmount: 3405n * 10n ** 6n,
      },
    ])
  })

  it('ignores logs emitted by anything other than the router swap', () => {
    expect(decodeSwaps([foreignLog()])).toEqual([])
  })

  it('returns every Swapped log in a receipt, in order', () => {
    const swaps = decodeSwaps([
      foreignLog(),
      swappedLog({ srcToken: WETH, dstToken: USDC, spentAmount: 1n, returnAmount: 2n }),
      foreignLog(),
      swappedLog({ srcToken: USDC, dstToken: WETH, spentAmount: 3n, returnAmount: 4n }),
    ])

    expect(swaps.map((s) => [s.spentAmount, s.returnAmount])).toEqual([
      [1n, 2n],
      [3n, 4n],
    ])
  })

  it('skips a Swapped log whose data is truncated rather than throwing', () => {
    const broken: LogLike = { address: ROUTER, topics: [SWAPPED_TOPIC], data: '0xdeadbeef' }
    const good = swappedLog({ srcToken: WETH, dstToken: USDC, spentAmount: 5n, returnAmount: 6n })

    expect(decodeSwaps([broken, good]).map((s) => s.spentAmount)).toEqual([5n])
  })

  it('skips a Swapped log with indexed arguments rather than decoding garbage', () => {
    // Not how the routers this app quotes emit it, but the topic hash is identical either way —
    // an indexed variant would otherwise decode into garbage amounts read off the wrong words.
    const indexed: LogLike = {
      address: ROUTER,
      topics: [SWAPPED_TOPIC, pad(ROUTER, { size: 32 }), pad(WETH, { size: 32 })],
      data: encodeAbiParameters(parseAbiParameters('address, address, uint256, uint256'), [
        USDC,
        USER,
        7n,
        8n,
      ]),
    }

    expect(decodeSwaps([indexed])).toEqual([])
  })
})

describe('walletDeltas', () => {
  it('counts a transfer into the wallet as a credit', () => {
    const deltas = walletDeltas([transferLog(USDC, OTHER, USER, 3405n * 10n ** 6n)], USER)

    expect(deltas).toEqual([{ token: USDC, delta: 3405n * 10n ** 6n }])
  })

  it('counts a transfer out of the wallet as a debit', () => {
    const deltas = walletDeltas([transferLog(WETH, USER, OTHER, 10n ** 18n)], USER)

    expect(deltas).toEqual([{ token: WETH, delta: -(10n ** 18n) }])
  })

  it('counts an aToken minted to the wallet, which Aave emits as a transfer from the zero address', () => {
    const deltas = walletDeltas([transferLog(A_WETH, ZERO, USER, 5n * 10n ** 17n)], USER)

    expect(deltas).toEqual([{ token: A_WETH, delta: 5n * 10n ** 17n }])
  })

  it('ignores transfers between other parties', () => {
    const deltas = walletDeltas([transferLog(USDC, OTHER, ROUTER, 100n)], USER)

    expect(deltas).toEqual([])
  })

  it('nets repeated movements of one token into a single entry', () => {
    const deltas = walletDeltas(
      [
        transferLog(USDC, OTHER, USER, 1000n),
        transferLog(USDC, USER, ROUTER, 250n),
        transferLog(USDC, OTHER, USER, 50n),
      ],
      USER,
    )

    expect(deltas).toEqual([{ token: USDC, delta: 800n }])
  })

  it('drops a token whose movements net to nothing', () => {
    const deltas = walletDeltas(
      [transferLog(WETH, OTHER, USER, 400n), transferLog(WETH, USER, ROUTER, 400n)],
      USER,
    )

    expect(deltas).toEqual([])
  })

  it('reports tokens in the order they first moved', () => {
    const deltas = walletDeltas(
      [transferLog(WETH, USER, ROUTER, 1n), transferLog(USDC, ROUTER, USER, 2n), transferLog(A_WETH, ZERO, USER, 3n)],
      USER,
    )

    expect(deltas.map((d) => d.token)).toEqual([WETH, USDC, A_WETH])
  })

  it('matches the wallet address whatever case the log is written in', () => {
    const deltas = walletDeltas([transferLog(USDC, OTHER, USER, 7n)], USER.toUpperCase() as Address)

    expect(deltas).toEqual([{ token: USDC, delta: 7n }])
  })

  it('ignores an ERC721 transfer, which shares the topic but indexes its token id', () => {
    // Four topics, empty data. Read as an ERC20 it would report a token id as an amount.
    const nft: LogLike = {
      address: OTHER,
      topics: [TRANSFER_TOPIC, pad(ZERO, { size: 32 }), pad(USER, { size: 32 }), pad('0x2a', { size: 32 })],
      data: '0x',
    }

    expect(walletDeltas([nft], USER)).toEqual([])
  })
})

describe('pickSwap', () => {
  const swap = (srcToken: Address, dstToken: Address, spentAmount: bigint) =>
    decodeSwaps([swappedLog({ srcToken, dstToken, spentAmount, returnAmount: 1n })])[0]

  it('reports nothing when the receipt carried no swap', () => {
    expect(pickSwap([], { srcToken: WETH, dstToken: USDC })).toBeNull()
  })

  it('picks the swap that moved the pair the flow was quoting', () => {
    const chosen = pickSwap(
      [swap(A_WETH, OTHER, 1n), swap(WETH, USDC, 2n), swap(USDC, WETH, 3n)],
      { srcToken: WETH, dstToken: USDC },
    )

    expect(chosen?.spentAmount).toBe(2n)
  })

  it('matches the pair whatever case the router wrote the addresses in', () => {
    const chosen = pickSwap([swap(WETH, USDC, 9n)], {
      srcToken: WETH.toLowerCase() as Address,
      dstToken: USDC.toLowerCase() as Address,
    })

    expect(chosen?.spentAmount).toBe(9n)
  })

  it('falls back to the first swap when none of them match the pair', () => {
    const chosen = pickSwap([swap(A_WETH, OTHER, 4n), swap(OTHER, A_WETH, 5n)], {
      srcToken: WETH,
      dstToken: USDC,
    })

    expect(chosen?.spentAmount).toBe(4n)
  })
})

describe('fillQuality', () => {
  const quoted = 3407_800000n // 3407.80 USDC the route said it would return
  const floor = 3404_400000n // what minOut allowed it to fill at

  it('reports a fill that landed exactly on the quote as no drift at all', () => {
    expect(fillQuality({ returnAmount: quoted, expectedOut: quoted, minOut: floor, basis: 'simulated' })).toEqual({
      delta: 0n,
      percent: 0,
      belowFloor: false,
      // Carried through so the delta can be read for what it compared against.
      basis: 'simulated',
    })
  })

  it('reports a fill under the quote as a shortfall', () => {
    const q = fillQuality({ returnAmount: 3405_100000n, expectedOut: quoted, minOut: floor , basis: 'simulated' })

    expect(q.delta).toBe(-2_700000n)
    expect(q.percent).toBeCloseTo(-0.0792, 4)
    expect(q.belowFloor).toBe(false)
  })

  it('reports a fill above the quote as a gain', () => {
    const q = fillQuality({ returnAmount: 3411_207800n, expectedOut: quoted, minOut: floor , basis: 'simulated' })

    expect(q.delta).toBe(3_407800n)
    expect(q.percent).toBeCloseTo(0.1, 4)
  })

  it('flags a fill that came in under the floor the transaction was meant to enforce', () => {
    const q = fillQuality({ returnAmount: floor - 1n, expectedOut: quoted, minOut: floor , basis: 'simulated' })

    expect(q.belowFloor).toBe(true)
  })

  it('leaves the percentage unstated when there is no quote to measure against', () => {
    const q = fillQuality({ returnAmount: 100n, expectedOut: 0n, minOut: 0n , basis: 'simulated' })

    expect(q.percent).toBeNull()
    expect(q.delta).toBe(100n)
  })
})

describe('readOutcome', () => {
  const receipt = [
    transferLog(WETH, USER, ROUTER, 10n ** 18n),
    swappedLog({ srcToken: WETH, dstToken: USDC, spentAmount: 10n ** 18n, returnAmount: 3405_100000n }),
    transferLog(USDC, ROUTER, USER, 3405_100000n),
  ]

  it('reports the swap, how it filled, and what the wallet ended up with', () => {
    const outcome = readOutcome({
      logs: receipt,
      wallet: USER,
      pair: { srcToken: WETH, dstToken: USDC },
      expectedOut: 3407_800000n,
      minOut: 3404_400000n,
    })

    expect(outcome?.swap?.returnAmount).toBe(3405_100000n)
    expect(outcome?.fill?.delta).toBe(-2_700000n)
    expect(outcome?.deltas).toEqual([
      { token: WETH, delta: -(10n ** 18n) },
      { token: USDC, delta: 3405_100000n },
    ])
  })

  it('reports nothing at all when the receipt moved none of the wallet and filled no swap', () => {
    // A receipt with nothing in it for this wallet has no report to make, and an empty panel
    // reads as a failed read rather than as a quiet transaction.
    const outcome = readOutcome({
      logs: [transferLog(USDC, ROUTER, OTHER, 5n)],
      wallet: USER,
      pair: { srcToken: WETH, dstToken: USDC },
      expectedOut: 1n,
      minOut: 1n,
    })

    expect(outcome).toBeNull()
  })

  it('still reports the wallet changes when the receipt carried no swap at all', () => {
    const outcome = readOutcome({
      logs: [transferLog(USDC, ROUTER, USER, 12n)],
      wallet: USER,
      pair: { srcToken: WETH, dstToken: USDC },
      expectedOut: 3407_800000n,
      minOut: 3404_400000n,
    })

    expect(outcome?.swap).toBeNull()
    expect(outcome?.fill).toBeNull()
    expect(outcome?.deltas).toEqual([{ token: USDC, delta: 12n }])
  })
})


describe('hideTokens', () => {
  const outcome = () =>
    readOutcome({
      logs: [
        transferLog(WETH, USER, ROUTER, 10n ** 18n),
        transferLog(A_WETH, ZERO, USER, 3n * 10n ** 18n),
        transferLog(USDC, ROUTER, USER, 7n),
      ],
      wallet: USER,
      pair: { srcToken: WETH, dstToken: USDC },
      expectedOut: 7n,
      minOut: 7n,
    })

  it('leaves out the tokens it is told to', () => {
    // The aToken and the variable-debt token are the POSITION, which has its own panel. Reporting
    // them as wallet changes says the same thing twice, in the units a user reads least.
    const hidden = hideTokens(outcome(), [A_WETH])

    expect(hidden?.deltas.map((d) => d.token)).toEqual([WETH, USDC])
  })

  it('matches what it hides whatever case it is given in', () => {
    const hidden = hideTokens(outcome(), [A_WETH.toUpperCase() as Address])

    expect(hidden?.deltas.map((d) => d.token)).toEqual([WETH, USDC])
  })

  it('leaves the swap and the fill exactly as they were', () => {
    const before = outcome()
    const after = hideTokens(before, [A_WETH])

    expect(after?.swap).toEqual(before?.swap)
    expect(after?.fill).toEqual(before?.fill)
  })

  it('keeps reporting a swap whose every wallet row was hidden', () => {
    const only = readOutcome({
      logs: [
        transferLog(A_WETH, ZERO, USER, 1n),
        swappedLog({ srcToken: WETH, dstToken: USDC, spentAmount: 1n, returnAmount: 2n }),
      ],
      wallet: USER,
      pair: { srcToken: WETH, dstToken: USDC },
      expectedOut: 2n,
      minOut: 2n,
    })

    const hidden = hideTokens(only, [A_WETH])

    expect(hidden?.swap?.returnAmount).toBe(2n)
    expect(hidden?.deltas).toEqual([])
  })

  it('reports nothing when hiding empties an outcome that had no swap either', () => {
    // Its own logs, not `outcome()`: those describe a token leaving and another coming back,
    // which IS a swap once transfers are read as a fallback for a router that emits no event.
    // Here nothing is sold, so there is no fill to find and hiding the rest leaves nothing.
    const noSwap = readOutcome({
      logs: [transferLog(A_WETH, ZERO, USER, 3n * 10n ** 18n)],
      wallet: USER,
      pair: { srcToken: WETH, dstToken: USDC },
      expectedOut: 0n,
      minOut: 0n,
    })

    expect(noSwap?.swap).toBeNull()
    expect(hideTokens(noSwap, [A_WETH])).toBeNull()
  })

  it('passes an absent outcome straight through', () => {
    expect(hideTokens(null, [A_WETH])).toBeNull()
  })
})

describe('decodeSwaps — Nordstern', () => {
  // Taken from a real close on Base, tx 0x8849dbd2…c819d: 220.0097 WETH sold into 536,836.583970
  // USDC through the Guard at 0xC87De04e…fC3d, with the Strategies contract as the user.
  const GUARD = '0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d' as Address
  const STRATEGIES = '0x75B1AB12e47AaEe4E1033100dE1992E735c32C9c' as Address
  const WETH = '0x4200000000000000000000000000000000000006' as Address
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address

  it('reads a fill from AggregatedTrade, which the Guard emits instead of Swapped', () => {
    // Nordstern is in COMPATIBLE_ADAPTERS, so its receipts reach every reader of this — the
    // settled report, the history basis, the fill price. Recognising only `Swapped` left all of
    // them silently empty on a Nordstern close rather than visibly wrong, which is worse.
    const swaps = decodeSwaps([
      aggregatedTradeLog({
        guard: GUARD,
        user: STRATEGIES,
        tokenIn: WETH,
        tokenOut: USDC,
        amountIn: 220009705635980620942n,
        amountOut: 536836583970n,
        minAmountOut: 536579553452n,
      }),
    ])

    expect(swaps).toEqual([
      {
        router: GUARD,
        sender: STRATEGIES,
        srcToken: WETH,
        dstToken: USDC,
        // The event names no receiver. The Guard pulls with `transferFrom(msg.sender, …)` and
        // returns the output to that same caller, so the user IS the receiver.
        dstReceiver: STRATEGIES,
        spentAmount: 220009705635980620942n,
        returnAmount: 536836583970n,
      },
    ])
  })

  it('reads both event shapes out of one receipt, in emission order', () => {
    // A flip sells one leg and buys another, and the two legs need not route through the same
    // aggregator. Readers index into this list positionally, so the order has to hold.
    const swaps = decodeSwaps([
      aggregatedTradeLog({
        guard: GUARD, user: STRATEGIES, tokenIn: WETH, tokenOut: USDC,
        amountIn: 1n, amountOut: 2n,
      }),
      swappedLog({
        address: GUARD, sender: STRATEGIES, srcToken: USDC, dstToken: WETH,
        dstReceiver: STRATEGIES, spentAmount: 3n, returnAmount: 4n,
      }),
    ])

    expect(swaps.map((s) => [s.spentAmount, s.returnAmount])).toEqual([[1n, 2n], [3n, 4n]])
  })
})

describe('swapFromTransfers', () => {
  // Base 0xbde5abe9d0985c278f4ec501853701469f225aae0edf76a814e9b8cb275893e0, a leveraged open
  // routed through Socket. Four of its 77 logs, in the order the transaction emitted them:
  // the flash loan arriving, the swap's input leaving, its output arriving, and the surplus
  // being supplied to Aave. The loan and the output are the SAME token, which is the whole
  // reason this reads a window rather than a sum.
  const STRATEGIES = '0x75b1ab12e47aaee4e1033100de1992e735c32c9c' as Address
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address
  const WETH = '0x4200000000000000000000000000000000000006' as Address
  const t = (a: string) => pad(a as Hex, { size: 32 })
  const LOGS = [
    // Morpho lends 10 WETH to the contract, before the swap exists.
    { address: WETH, topics: [TRANSFER_TOPIC, t('0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb'), t(STRATEGIES)] as Hex[],
      data: '0x0000000000000000000000000000000000000000000000008ac7230489e80000' as Hex },
    // 25,257.913359 USDC out to Socket's settler.
    { address: USDC, topics: [TRANSFER_TOPIC, t(STRATEGIES), t('0x50cfe7c1938db66a1a6d2e86d36f39fbef3d5c4a')] as Hex[],
      data: '0x00000000000000000000000000000000000000000000000000000005e17d2c0f' as Hex },
    // 10.0354798 WETH back from the 0x Settler. No swap event anywhere in the receipt.
    { address: WETH, topics: [TRANSFER_TOPIC, t('0x7747f8d2a76bd6345cc29622a946a929647f2359'), t(STRATEGIES)] as Hex[],
      data: '0x0000000000000000000000000000000000000000000000008b452fb5147124bc' as Hex },
    // The 0.0354798 surplus supplied to Aave.
    { address: WETH, topics: [TRANSFER_TOPIC, t(STRATEGIES), t('0xd4a0e0b9149bcee3c920d2e00b5de09138fd8bb7')] as Hex[],
      data: '0x000000000000000000000000000000000000000000000000007e0cb08a8924bc' as Hex },
  ]

  it('reads the fill a router announced no event for', () => {
    const swap = swapFromTransfers(LOGS, STRATEGIES, { srcToken: USDC, dstToken: WETH })

    expect(swap?.spentAmount).toBe(25_257_913_359n)
    expect(swap?.returnAmount).toBe(10_035_479_799_443_563_708n)
  })

  it('leaves the flash loan out, though it arrives in the swap output token', () => {
    const swap = swapFromTransfers(LOGS, STRATEGIES, { srcToken: USDC, dstToken: WETH })

    // Scanning from the top instead would find the 10 WETH loan first and report that as the
    // fill. From the bottom the loan is never reached.
    expect(swap!.returnAmount).toBeLessThan(11n * 10n ** 18n)
  })

  it('answers null rather than half a fill when the receipt holds no swap', () => {
    // The loan and the Aave supply alone: nothing ever left in USDC.
    expect(swapFromTransfers([LOGS[0], LOGS[3]], STRATEGIES, { srcToken: USDC, dstToken: WETH })).toBeNull()
  })

  it('ignores transfers belonging to somebody else', () => {
    const other = '0x000000000000000000000000000000000000dead' as Address
    expect(swapFromTransfers(LOGS, other, { srcToken: USDC, dstToken: WETH })).toBeNull()
  })
})
