import { describe, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'
import {

  scanPositionEvents,
  type LogScanClient,
  type RawPositionLog,
} from './strategiesLogs'

const STRATEGIES = '0x75b1ab12e47aaee4e1033100de1992e735c32c9c' as Address
const WALLET = '0x1111111111111111111111111111111111111111' as Address
const WETH = '0x4200000000000000000000000000000000000006' as Address
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex

function log(over: Partial<RawPositionLog> = {}): RawPositionLog {
  return {
    eventName: 'PositionOpened',
    transactionHash: hash(1),
    blockNumber: 150n,
    logIndex: 3,
    args: { user: WALLET, collateral: WETH, debtAsset: USDC },
    ...over,
  }
}

/** Records every range it was asked about, and answers from a per-call script. */
function client(answers: (RawPositionLog[] | Error)[] = [[]]) {
  const calls: { fromBlock: bigint; toBlock: bigint }[] = []
  let i = 0
  const scan: LogScanClient = {
    getLogs: async (args) => {
      calls.push({ fromBlock: args.fromBlock, toBlock: args.toBlock })
      const answer = answers[Math.min(i, answers.length - 1)]
      i++
      if (answer instanceof Error) throw answer
      return answer
    },
  }
  return { scan, calls }
}

const range = { address: STRATEGIES, wallet: WALLET, fromBlock: 100n, toBlock: 200n }

describe('scanPositionEvents', () => {
  it('reads an open, with the pair the event named', () => {
    // The indexed collateral and debtAsset are what make the swap direction knowable without
    // guessing at the receipt: an open swaps debt into collateral.
    return scanPositionEvents(client([[log()]]).scan, range).then((events) => {
      expect(events).toEqual([
        {
          hash: hash(1),
          blockNumber: 150n,
          logIndex: 3,
          kind: 'open',
          collateral: WETH,
          debtAsset: USDC,
        },
      ])
    })
  })

  it('reads a close', async () => {
    const events = await scanPositionEvents(client([[log({ eventName: 'PositionClosed' })]]).scan, range)

    expect(events[0].kind).toBe('close')
  })

  it('ignores an event it does not understand', async () => {
    // The filter is built from two events, but a provider answering a looser filter than it was
    // given would otherwise produce a row with a meaningless kind.
    const events = await scanPositionEvents(client([[log({ eventName: 'RouterSet' })]]).scan, range)

    expect(events).toEqual([])
  })

  it('ignores a log that has not been mined into a block yet', async () => {
    const answers = [[log({ blockNumber: null }), log({ transactionHash: null })]]

    expect(await scanPositionEvents(client(answers).scan, range)).toEqual([])
  })

  it('ignores a log missing the addresses it is read for', async () => {
    const answers = [[log({ args: { user: WALLET, collateral: undefined, debtAsset: USDC } })]]

    expect(await scanPositionEvents(client(answers).scan, range)).toEqual([])
  })

  it('asks only about this wallet, at this address', async () => {
    const getLogs = vi.fn().mockResolvedValue([])

    await scanPositionEvents({ getLogs }, range)

    expect(getLogs.mock.calls[0][0]).toMatchObject({ address: STRATEGIES, wallet: WALLET })
  })

  it('covers the whole range without a gap or an overlap', async () => {
    // A gap is a transaction that silently never appears; an overlap is wasted requests. The
    // windows are inclusive at both ends, which is the easy thing to get wrong by one.
    const { scan, calls } = client()

    await scanPositionEvents(scan, { ...range, fromBlock: 0n, toBlock: 25n, initialChunk: 10n })

    expect(calls).toEqual([
      { fromBlock: 0n, toBlock: 9n },
      { fromBlock: 10n, toBlock: 19n },
      { fromBlock: 20n, toBlock: 25n },
    ])
  })

  it('scans a single block', async () => {
    const { scan, calls } = client()

    await scanPositionEvents(scan, { ...range, fromBlock: 7n, toBlock: 7n })

    expect(calls).toEqual([{ fromBlock: 7n, toBlock: 7n }])
  })

  it('asks nothing when there is nothing new to scan', async () => {
    // The ordinary case on every load after the first: the cursor is already at the head.
    const { scan, calls } = client()

    expect(await scanPositionEvents(scan, { ...range, fromBlock: 200n, toBlock: 199n })).toEqual([])
    expect(calls).toEqual([])
  })

  it('halves the window and retries the same block when the provider refuses', async () => {
    // Providers cap ranges and result counts, and say so in wording that differs per provider.
    // Backing off on ANY failure avoids matching on error strings.
    const { scan, calls } = client([new Error('query returned more than 10000 results'), []])

    await scanPositionEvents(scan, {
      ...range, fromBlock: 0n, toBlock: 100n, initialChunk: 40n, minChunk: 10n,
    })

    expect(calls[0]).toEqual({ fromBlock: 0n, toBlock: 39n })
    expect(calls[1]).toEqual({ fromBlock: 0n, toBlock: 19n })
  })

  it('gives up rather than shrinking forever', async () => {
    const { scan } = client([new Error('nope')])

    await expect(
      scanPositionEvents(scan, {
        ...range, fromBlock: 0n, toBlock: 100n, initialChunk: 10n, minChunk: 10n,
      }),
    ).rejects.toThrow('nope')
  })

  it('stops shrinking at the floor rather than at zero', async () => {
    // A window of zero blocks would loop forever without ever asking about anything.
    const { scan, calls } = client([new Error('a'), new Error('b'), []])

    await expect(
      scanPositionEvents(scan, {
        ...range, fromBlock: 0n, toBlock: 100n, initialChunk: 30n, minChunk: 20n,
      }),
    ).rejects.toThrow('b')
    expect(calls).toEqual([
      { fromBlock: 0n, toBlock: 29n },
      { fromBlock: 0n, toBlock: 19n },
    ])
  })

  it('throws rather than returning what it managed to read', async () => {
    // The contract the prune depends on. A partial result reaching `mergeHistory` would look
    // exactly like proof that the transactions it never reached do not exist.
    const { scan } = client([[log()], new Error('gateway timeout')])

    await expect(
      scanPositionEvents(scan, {
        ...range, fromBlock: 0n, toBlock: 100n, initialChunk: 10n, minChunk: 10n,
      }),
    ).rejects.toThrow('gateway timeout')
  })

  it('reports each block it has got as far as', async () => {
    const seen: bigint[] = []
    const { scan } = client()

    await scanPositionEvents(scan, {
      ...range, fromBlock: 0n, toBlock: 25n, initialChunk: 10n, onProgress: (b) => seen.push(b),
    })

    expect(seen).toEqual([9n, 19n, 25n])
  })

  it('reports one transaction once even if a range is answered twice', async () => {
    const { scan } = client([[log(), log()]])

    expect(await scanPositionEvents(scan, range)).toHaveLength(1)
  })
})
