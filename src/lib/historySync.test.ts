import { describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, parseAbiParameters, type Address, type Hex } from 'viem'
import { REORG_WINDOW, syncChain, type ChainSyncClient } from './historySync'
import { SWAPPED_TOPIC, type ReceiptLog } from './txOutcome'
import { appendHistory, loadHistory, type TxHistoryEntry } from './txHistory'
import { loadCursor, saveCursor } from './syncCursor'
import type { DelegationStorage } from './delegationCache'
import type { RawPositionLog } from './strategiesLogs'

const STRATEGIES = '0x75b1ab12e47aaee4e1033100de1992e735c32c9c' as Address
const WALLET = '0x1111111111111111111111111111111111111111' as Address
const WETH = '0x4200000000000000000000000000000000000006' as Address
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' as Address
const DEPLOY_BLOCK = 49_831_780n

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex

function memoryStorage(): DelegationStorage {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

const swappedLog: ReceiptLog = {
  address: ROUTER,
  topics: [SWAPPED_TOPIC],
  data: encodeAbiParameters(parseAbiParameters('address, address, address, address, uint256, uint256'), [
    ROUTER, USDC, WETH, WALLET, 3405_100000n, 10n ** 18n,
  ]),
}

function positionLog(over: Partial<RawPositionLog> = {}): RawPositionLog {
  return {
    eventName: 'PositionOpened',
    transactionHash: hash(1),
    blockNumber: DEPLOY_BLOCK + 10n,
    logIndex: 0,
    args: { user: WALLET, collateral: WETH, debtAsset: USDC },
    ...over,
  }
}

function client(o: { head?: bigint; logs?: RawPositionLog[] } = {}) {
  const getBlockNumber = vi.fn().mockResolvedValue(o.head ?? DEPLOY_BLOCK + 1000n)
  const getLogs = vi.fn().mockResolvedValue(o.logs ?? [])
  const getTransactionReceipt = vi.fn().mockResolvedValue({ logs: [swappedLog], status: 'success' })
  const getBlock = vi.fn().mockResolvedValue({ timestamp: 1_800_000_000n })
  return { getBlockNumber, getLogs, getTransactionReceipt, getBlock } satisfies ChainSyncClient
}

const base = {
  address: STRATEGIES,
  wallet: WALLET,
  chainId: 8453,
  fromBlock: DEPLOY_BLOCK,
  tokens: {
    [WETH.toLowerCase()]: { symbol: 'WETH', decimals: 18 },
    [USDC.toLowerCase()]: { symbol: 'USDC', decimals: 6 },
  },
  hidden: [],
}

/** A row already in storage, as the live path would have written it. */
function stored(over: Partial<TxHistoryEntry> = {}): TxHistoryEntry {
  return {
    hash: hash(1),
    chainId: 8453,
    wallet: WALLET,
    kind: 'open',
    at: 1_000_000,
    swap: null,
    rate: null,
    fill: null,
    deltas: [],
    source: 'chain',
    blockNumber: DEPLOY_BLOCK + 10n,
    ...over,
  }
}

describe('syncChain', () => {
  it('starts at the deployment when this wallet has never been scanned', async () => {
    const c = client()

    await syncChain({ ...base, client: c, storage: memoryStorage() })

    expect(c.getLogs.mock.calls[0][0].fromBlock).toBe(DEPLOY_BLOCK)
  })

  it('resumes from where the last scan stopped', async () => {
    // The reason a second load does not re-walk four hundred million Arbitrum blocks.
    const storage = memoryStorage()
    saveCursor(storage, { chainId: 8453, wallet: WALLET }, DEPLOY_BLOCK + 500n)
    const c = client()

    await syncChain({ ...base, client: c, storage })

    expect(c.getLogs.mock.calls[0][0].fromBlock).toBe(DEPLOY_BLOCK + 501n)
  })

  it('records what it found', async () => {
    const storage = memoryStorage()

    await syncChain({ ...base, client: client({ logs: [positionLog()] }), storage })

    const [row] = loadHistory(storage, { wallet: WALLET, chainId: 8453 })
    expect(row.hash).toBe(hash(1))
    expect(row.source).toBe('chain')
    expect(row.rate).toBe('0.000293677131361780858')
  })

  it('stops the cursor short of the head, so a reorg near the tip is re-read', async () => {
    // The head is the least settled part of the chain. Parking the cursor on it means a
    // transaction that reorgs out one block later is never looked at again.
    const storage = memoryStorage()
    const head = DEPLOY_BLOCK + 1000n

    await syncChain({ ...base, client: client({ head }), storage })

    expect(loadCursor(storage, { chainId: 8453, wallet: WALLET })).toBe(head - REORG_WINDOW)
  })

  it('scans up to the head even though it does not trust it yet', async () => {
    const c = client({ head: DEPLOY_BLOCK + 1000n })

    await syncChain({ ...base, client: c, storage: memoryStorage() })

    const last = c.getLogs.mock.calls.at(-1)![0]
    expect(last.toBlock).toBe(DEPLOY_BLOCK + 1000n)
  })

  it('drops a row the chain no longer confirms', async () => {
    const storage = memoryStorage()
    appendHistory(storage, stored())

    await syncChain({ ...base, client: client({ logs: [] }), storage })

    expect(loadHistory(storage)).toEqual([])
  })

  it('keeps everything when the scan fails, and does not advance the cursor', async () => {
    // The failure that matters. A scan that threw knows nothing about what exists, and must not
    // leave behind either a deletion or a cursor claiming that range was covered.
    const storage = memoryStorage()
    appendHistory(storage, stored())
    const c = client()
    c.getLogs.mockRejectedValue(new Error('rate limited'))

    await expect(syncChain({ ...base, client: c, storage })).rejects.toThrow('rate limited')

    expect(loadHistory(storage)).toHaveLength(1)
    expect(loadCursor(storage, { chainId: 8453, wallet: WALLET })).toBeNull()
  })

  it('keeps everything when a receipt fails to load', async () => {
    const storage = memoryStorage()
    appendHistory(storage, stored({ hash: hash(2), blockNumber: DEPLOY_BLOCK + 11n }))
    const c = client({ logs: [positionLog()] })
    c.getTransactionReceipt.mockRejectedValue(new Error('receipt unavailable'))

    await expect(syncChain({ ...base, client: c, storage })).rejects.toThrow('receipt unavailable')

    expect(loadHistory(storage)).toHaveLength(1)
    expect(loadCursor(storage, { chainId: 8453, wallet: WALLET })).toBeNull()
  })

  it('leaves a row older than the range it scanned', async () => {
    // An incremental sync has no opinion about blocks it did not look at.
    const storage = memoryStorage()
    appendHistory(storage, stored({ blockNumber: DEPLOY_BLOCK + 1n }))
    saveCursor(storage, { chainId: 8453, wallet: WALLET }, DEPLOY_BLOCK + 500n)

    await syncChain({ ...base, client: client({ logs: [] }), storage })

    expect(loadHistory(storage)).toHaveLength(1)
  })

  it('asks for nothing when the cursor has already passed the head', async () => {
    const storage = memoryStorage()
    saveCursor(storage, { chainId: 8453, wallet: WALLET }, DEPLOY_BLOCK + 5000n)
    const c = client({ head: DEPLOY_BLOCK + 1000n })

    const result = await syncChain({ ...base, client: c, storage })

    expect(c.getLogs).not.toHaveBeenCalled()
    expect(result.scanned).toBeNull()
  })

  it('reports the range it covered and what it found', async () => {
    const result = await syncChain({
      ...base, client: client({ logs: [positionLog()] }), storage: memoryStorage(),
    })

    expect(result).toEqual({
      scanned: { from: DEPLOY_BLOCK, to: DEPLOY_BLOCK + 1000n },
      found: 1,
    })
  })

  it('never scans before the deployment, whatever the cursor says', async () => {
    const storage = memoryStorage()
    saveCursor(storage, { chainId: 8453, wallet: WALLET }, 1n)
    const c = client()

    await syncChain({ ...base, client: c, storage })

    expect(c.getLogs.mock.calls[0][0].fromBlock).toBe(DEPLOY_BLOCK)
  })
})
