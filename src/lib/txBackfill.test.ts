import { describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, pad, parseAbiParameters, type Address, type Hex } from 'viem'
import {
  RECEIPT_CONCURRENCY,
  entriesFromEvents,
  type BackfillContext,
  type ReceiptClient,
} from './txBackfill'
import { SWAPPED_TOPIC, type ReceiptLog } from './txOutcome'
import type { PositionEvent } from './strategiesLogs'

const ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' as Address
const WALLET = '0x1111111111111111111111111111111111111111' as Address
const STRATEGIES = '0x75B1AB12e47AaEe4E1033100dE1992E735c32C9c' as Address
const WETH = '0x4200000000000000000000000000000000000006' as Address
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const A_WETH = '0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8' as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex

const swappedLog = (o: {
  srcToken: Address
  dstToken: Address
  spentAmount: bigint
  returnAmount: bigint
}): ReceiptLog => ({
  address: ROUTER,
  topics: [SWAPPED_TOPIC],
  data: encodeAbiParameters(parseAbiParameters('address, address, address, address, uint256, uint256'), [
    ROUTER, o.srcToken, o.dstToken, WALLET, o.spentAmount, o.returnAmount,
  ]),
})

const transferLog = (token: Address, from: Address, to: Address, value: bigint): ReceiptLog => ({
  address: token,
  topics: [TRANSFER_TOPIC, pad(from, { size: 32 }), pad(to, { size: 32 })],
  data: encodeAbiParameters(parseAbiParameters('uint256'), [value]),
})

/** An open: 3405.1 USDC of borrowed debt swapped into 1 WETH, which is supplied as collateral. */
const OPEN_LOGS: ReceiptLog[] = [
  swappedLog({ srcToken: USDC, dstToken: WETH, spentAmount: 3405_100000n, returnAmount: 10n ** 18n }),
  transferLog(USDC, ZERO, WALLET, 3405_100000n),
  transferLog(A_WETH, ZERO, WALLET, 10n ** 18n),
]

function openEvent(over: Partial<PositionEvent> = {}): PositionEvent {
  return {
    hash: hash(1),
    blockNumber: 150n,
    logIndex: 3,
    kind: 'open',
    collateral: WETH,
    debtAsset: USDC,
    ...over,
  }
}

const CONTEXT: BackfillContext = {
  wallet: WALLET,
  chainId: 8453,
  strategies: STRATEGIES,
  tokens: {
    [WETH.toLowerCase()]: { symbol: 'WETH', decimals: 18 },
    [USDC.toLowerCase()]: { symbol: 'USDC', decimals: 6 },
  },
  hidden: [A_WETH],
}

function client(o: { logs?: ReceiptLog[]; status?: 'success' | 'reverted'; timestamp?: bigint } = {}) {
  const getTransactionReceipt = vi.fn().mockResolvedValue({
    logs: o.logs ?? OPEN_LOGS,
    status: o.status ?? 'success',
  })
  const getBlock = vi.fn().mockResolvedValue({ timestamp: o.timestamp ?? 1_800_000_000n })
  return { getTransactionReceipt, getBlock } satisfies ReceiptClient
}

describe('entriesFromEvents', () => {
  it('recovers what an open actually filled at', async () => {
    // The whole point: this number exists nowhere but the receipt, and the receipt is the one
    // thing a user cannot read off an explorer in a form that means anything.
    const [entry] = await entriesFromEvents(client(), [openEvent()], CONTEXT)

    // Carried at full precision rather than at a fixed six places: this side of the pair is the
    // small one, and six places would leave three significant digits that cannot be inverted.
    expect(entry.rate).toBe('0.000293677131361780858')
    expect(entry.swap).toMatchObject({
      srcToken: USDC, dstToken: WETH, srcSymbol: 'USDC', dstSymbol: 'WETH',
      spentAmount: 3405_100000n, returnAmount: 10n ** 18n,
    })
  })

  it('marks the row as read off the chain, at the block it settled in', async () => {
    const [entry] = await entriesFromEvents(client(), [openEvent()], CONTEXT)

    expect(entry.source).toBe('chain')
    expect(entry.blockNumber).toBe(150n)
    expect(entry.kind).toBe('open')
    expect(entry.chainId).toBe(8453)
    expect(entry.wallet).toBe(WALLET)
  })

  it('dates the row by its block, not by when it was recovered', async () => {
    const [entry] = await entriesFromEvents(client({ timestamp: 1_755_000_000n }), [openEvent()], CONTEXT)

    expect(entry.at).toBe(1_755_000_000_000)
  })

  it('never claims a fill quality it cannot know', async () => {
    // `expectedOut` and `minOut` came from a quote that exists nowhere on chain. Reporting a
    // recovered row as "0.0000% below the quote" would be an invented number.
    const [entry] = await entriesFromEvents(client(), [openEvent()], CONTEXT)

    expect(entry.fill).toBeNull()
  })

  it('picks the swap the event named out of a receipt carrying several', async () => {
    // Better than the live path can do: the event's indexed collateral and debtAsset say which
    // leg was this position's, so there is no falling back to "the first one in the receipt".
    const logs = [
      swappedLog({ srcToken: WETH, dstToken: ROUTER, spentAmount: 1n, returnAmount: 2n }),
      ...OPEN_LOGS,
    ]

    const [entry] = await entriesFromEvents(client({ logs }), [openEvent()], CONTEXT)

    expect(entry.swap?.spentAmount).toBe(3405_100000n)
  })

  it('reads a close in the other direction', async () => {
    // A close sells collateral to buy back the debt — the reverse of an open.
    const logs = [
      swappedLog({ srcToken: WETH, dstToken: USDC, spentAmount: 10n ** 18n, returnAmount: 3400_000000n }),
      swappedLog({ srcToken: USDC, dstToken: WETH, spentAmount: 1n, returnAmount: 2n }),
    ]

    const [entry] = await entriesFromEvents(
      client({ logs }), [openEvent({ kind: 'close' })], CONTEXT,
    )

    expect(entry.kind).toBe('close')
    expect(entry.swap).toMatchObject({ srcToken: WETH, dstToken: USDC, spentAmount: 10n ** 18n })
  })

  it('leaves the position tokens out of the wallet rows', async () => {
    // Aave mints the aToken to the user, so it nets into the deltas and describes the POSITION,
    // which already has a panel of its own.
    const [entry] = await entriesFromEvents(client(), [openEvent()], CONTEXT)

    expect(entry.deltas.map((d) => d.token)).toEqual([USDC])
  })

  it('records a token it cannot name rather than dropping it', async () => {
    const [entry] = await entriesFromEvents(client(), [openEvent()], { ...CONTEXT, tokens: {} })

    expect(entry.swap?.srcSymbol).toBeNull()
    expect(entry.swap?.srcDecimals).toBeNull()
    // Without both sides' decimals there are two integers and no rate between them.
    expect(entry.rate).toBeNull()
  })

  it('still records a transaction whose receipt carried no swap', async () => {
    // The event is proof the transaction happened. A row with a hash and a date is worth more
    // than no row at all, and this is how a reverted-then-retried afternoon reads back.
    const [entry] = await entriesFromEvents(client({ logs: [] }), [openEvent()], CONTEXT)

    expect(entry.swap).toBeNull()
    expect(entry.hash).toBe(hash(1))
  })

  it('skips a transaction the chain says did not succeed', async () => {
    const entries = await entriesFromEvents(client({ status: 'reverted' }), [openEvent()], CONTEXT)

    expect(entries).toEqual([])
  })

  it('asks about each block once however many transactions share it', async () => {
    const c = client()

    await entriesFromEvents(
      c,
      [openEvent({ hash: hash(1) }), openEvent({ hash: hash(2) }), openEvent({ hash: hash(3) })],
      CONTEXT,
    )

    expect(c.getBlock).toHaveBeenCalledTimes(1)
    expect(c.getTransactionReceipt).toHaveBeenCalledTimes(3)
  })

  it('throws rather than returning the rows it managed to build', async () => {
    // Same contract as the scan, and for the same reason: a transaction dropped here because its
    // receipt would not load is a transaction `mergeHistory` would then delete from storage.
    const c = client()
    c.getTransactionReceipt.mockRejectedValueOnce(new Error('receipt unavailable'))

    await expect(entriesFromEvents(c, [openEvent()], CONTEXT)).rejects.toThrow('receipt unavailable')
  })

  it('throws when a block timestamp cannot be read', async () => {
    const c = client()
    c.getBlock.mockRejectedValueOnce(new Error('block unavailable'))

    await expect(entriesFromEvents(c, [openEvent()], CONTEXT)).rejects.toThrow('block unavailable')
  })

  it('does nothing at all when there is nothing to build', async () => {
    const c = client()

    expect(await entriesFromEvents(c, [], CONTEXT)).toEqual([])
    expect(c.getBlock).not.toHaveBeenCalled()
  })
})

describe('entriesFromEvents request load', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => openEvent({ hash: hash(i), blockNumber: BigInt(150 + i) }))

  it('holds the number of receipts in flight down to a limit a provider will serve', async () => {
    // A first scan of a busy wallet turns up hundreds of transactions. Asking for every receipt
    // at once is either one oversized batch POST or a self-inflicted rate limit.
    let live = 0
    let peak = 0
    const c = client()
    c.getTransactionReceipt.mockImplementation(async () => {
      live++
      peak = Math.max(peak, live)
      await Promise.resolve()
      live--
      return { logs: OPEN_LOGS, status: 'success' }
    })

    await entriesFromEvents(c, many(100), CONTEXT)

    expect(peak).toBeLessThanOrEqual(RECEIPT_CONCURRENCY)
    expect(c.getTransactionReceipt).toHaveBeenCalledTimes(100)
  })

  it('keeps every row lined up with the event it came from', async () => {
    // The pooled workers finish out of order; the results must not.
    const entries = await entriesFromEvents(client(), many(50), CONTEXT)

    expect(entries.map((e) => e.hash)).toEqual(many(50).map((e) => e.hash))
    expect(entries.map((e) => e.blockNumber)).toEqual(many(50).map((e) => e.blockNumber))
  })
})
