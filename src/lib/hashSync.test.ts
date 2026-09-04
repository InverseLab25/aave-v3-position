import { describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, parseAbiParameters, type Address, type Hex } from 'viem'
import { syncChainFromHashes } from './hashSync'
import { POSITION_OPENED_TOPIC } from './receiptScreen'
import { loadScreened } from './screenCache'
import { loadHistory, mergeHistory } from './txHistory'
import { SWAPPED_TOPIC } from './txOutcome'
import type { ScreenedReceipt } from './receiptScreen'
import type { DelegationStorage } from './delegationCache'

const STRATEGIES = '0x75B1AB12e47AaEe4E1033100dE1992E735c32C9c' as Address
const POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' as Address
const WALLET = '0x253FaC550bae1EE9B4680b3735DC38a3f6eCd600' as Address
const WETH = '0x4200000000000000000000000000000000000006' as Address
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex
const topicOf = (a: Address) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}` as Hex

function memoryStorage(): DelegationStorage {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

/** A leveraged open: the strategies contract's event, plus the router's fill. */
const openReceipt = (h: Hex) => ({
  hash: h,
  to: STRATEGIES as Address | null,
  status: 'success' as const,
  blockNumber: 500n,
  logs: [
    { address: STRATEGIES, topics: [POSITION_OPENED_TOPIC, topicOf(WALLET), topicOf(WETH), topicOf(USDC)] as Hex[], data: '0x' as Hex },
    {
      address: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' as Address,
      topics: [SWAPPED_TOPIC] as Hex[],
      data: encodeAbiParameters(
        parseAbiParameters('address, address, address, address, uint256, uint256'),
        [STRATEGIES, USDC, WETH, STRATEGIES, 1_899_171_711n, 1_003_307_090_025_359_338n],
      ),
    },
  ],
})

/** An ordinary Aave supply — what most of the indexer's hashes turn out to be. */
const plainReceipt = (h: Hex) => ({
  hash: h,
  to: POOL as Address | null,
  status: 'success' as const,
  blockNumber: 400n,
  logs: [{ address: POOL, topics: [`0x${'cd'.repeat(32)}` as Hex] as Hex[], data: '0x' as Hex }],
})

function client(receipts: Record<string, ScreenedReceipt>) {
  const getTransactionReceipt = vi.fn(async ({ hash: h }: { hash: Hex }) => receipts[h.toLowerCase()])
  const getBlock = vi.fn(async () => ({ timestamp: 1_800_000_000n }))
  return { getTransactionReceipt, getBlock }
}

const CONTEXT = {
  wallet: WALLET,
  chainId: 8453,
  strategies: STRATEGIES,
  tokens: {
    [WETH.toLowerCase()]: { symbol: 'WETH', decimals: 18 },
    [USDC.toLowerCase()]: { symbol: 'USDC', decimals: 6 },
  },
  hidden: [] as readonly Address[],
}

describe('syncChainFromHashes', () => {
  it('files the strategies transaction and passes over the rest', async () => {
    const storage = memoryStorage()
    const c = client({ [hash(1)]: openReceipt(hash(1)), [hash(2)]: plainReceipt(hash(2)) })

    const result = await syncChainFromHashes({ ...CONTEXT, client: c, storage, hashes: [hash(1), hash(2)] })

    expect(result.found).toBe(1)
    const rows = loadHistory(storage, { wallet: WALLET, chainId: 8453 })
    expect(rows).toHaveLength(1)
    expect(rows[0].hash).toBe(hash(1))
    expect(rows[0].kind).toBe('open')
    expect(rows[0].swap).toMatchObject({ srcToken: USDC, dstToken: WETH, spentAmount: 1_899_171_711n })
  })

  it('reads a hash again when told to, though screening says it is done', async () => {
    // How an already-filed row repairs itself. Screening remembers every hash it has judged, so
    // a row decoded by a reader that could not see its swap would stay incomplete forever — and
    // the indexer does not always list our own transactions, so its hash may never be offered
    // again either. `reread` is the way back to that receipt.
    const storage = memoryStorage()
    const receipts = { [hash(1)]: openReceipt(hash(1)) }

    const first = client(receipts)
    await syncChainFromHashes({ ...CONTEXT, client: first, storage, hashes: [hash(1)] })
    expect(first.getTransactionReceipt).toHaveBeenCalledTimes(1)

    const second = client(receipts)
    await syncChainFromHashes({ ...CONTEXT, client: second, storage, hashes: [hash(1)] })
    expect(second.getTransactionReceipt).not.toHaveBeenCalled()

    const third = client(receipts)
    await syncChainFromHashes({ ...CONTEXT, client: third, storage, hashes: [hash(1)], reread: [hash(1)] })
    expect(third.getTransactionReceipt).toHaveBeenCalledTimes(1)
  })

  it('fetches a re-read hash once, not twice, when the indexer lists it too', async () => {
    const storage = memoryStorage()
    const c = client({ [hash(1)]: openReceipt(hash(1)) })

    await syncChainFromHashes({ ...CONTEXT, client: c, storage, hashes: [hash(1)], reread: [hash(1)] })

    expect(c.getTransactionReceipt).toHaveBeenCalledTimes(1)
  })

  it('repairs a stored row the indexer no longer lists', async () => {
    // The failure this exists for. A row filed with no swap on it, its hash already screened, and
    // the indexer not listing the transaction at all — so `hashes` is empty and nothing else can
    // ever offer that receipt again. Only the row's own hash gets back to it.
    const storage = memoryStorage()
    const receipts = { [hash(1)]: openReceipt(hash(1)) }

    const first = client(receipts)
    await syncChainFromHashes({ ...CONTEXT, client: first, storage, hashes: [hash(1)] })
    // Blank the swap the way the old decoder left it.
    mergeHistory(storage, {
      wallet: WALLET, chainId: 8453, range: null,
      entries: [{ ...loadHistory(storage, { wallet: WALLET, chainId: 8453 })[0], swap: null, source: 'chain' }],
    })

    const second = client(receipts)
    await syncChainFromHashes({ ...CONTEXT, client: second, storage, hashes: [], reread: [hash(1)] })

    expect(second.getTransactionReceipt).toHaveBeenCalledTimes(1)
    expect(loadHistory(storage, { wallet: WALLET, chainId: 8453 })[0].swap).toMatchObject({
      srcToken: USDC,
      dstToken: WETH,
    })
  })

  it('never reads the same receipt twice across runs', async () => {
    // The whole reason for the cache: a second load costs no receipt fetches at all.
    const storage = memoryStorage()
    const receipts = { [hash(1)]: openReceipt(hash(1)), [hash(2)]: plainReceipt(hash(2)) }

    const first = client(receipts)
    await syncChainFromHashes({ ...CONTEXT, client: first, storage, hashes: [hash(1), hash(2)] })
    expect(first.getTransactionReceipt).toHaveBeenCalledTimes(2)

    const second = client(receipts)
    await syncChainFromHashes({ ...CONTEXT, client: second, storage, hashes: [hash(1), hash(2)] })
    expect(second.getTransactionReceipt).not.toHaveBeenCalled()
  })

  it('records what each hash turned out to be', async () => {
    const storage = memoryStorage()
    const c = client({ [hash(1)]: openReceipt(hash(1)), [hash(2)]: plainReceipt(hash(2)) })

    await syncChainFromHashes({ ...CONTEXT, client: c, storage, hashes: [hash(1), hash(2)] })

    const seen = loadScreened(storage, { wallet: WALLET, chainId: 8453 })
    expect(seen.get(hash(1))).toBe('strategies')
    expect(seen.get(hash(2))).toBe('other')
  })

  it('reads one receipt for a hash the indexer reported several times', async () => {
    // One leveraged open produces a supply, a borrow and a second supply — three rows, one hash.
    const storage = memoryStorage()
    const c = client({ [hash(1)]: openReceipt(hash(1)) })

    await syncChainFromHashes({ ...CONTEXT, client: c, storage, hashes: [hash(1), hash(1), hash(1)] })

    expect(c.getTransactionReceipt).toHaveBeenCalledTimes(1)
    expect(loadHistory(storage, { wallet: WALLET, chainId: 8453 })).toHaveLength(1)
  })

  it('keeps a row it did not see this time', async () => {
    // Discovery walks hashes, not blocks, so it can never say a transaction is absent from a
    // range it never examined. `mergeHistory` is given no range for exactly that reason.
    const storage = memoryStorage()
    await syncChainFromHashes({
      ...CONTEXT,
      client: client({ [hash(1)]: openReceipt(hash(1)) }),
      storage,
      hashes: [hash(1)],
    })

    await syncChainFromHashes({ ...CONTEXT, client: client({}), storage, hashes: [] })

    expect(loadHistory(storage, { wallet: WALLET, chainId: 8453 })).toHaveLength(1)
  })

  it('does not file a transaction the chain reports as reverted', async () => {
    const storage = memoryStorage()
    const reverted = { ...openReceipt(hash(1)), status: 'reverted' as const }
    const c = client({ [hash(1)]: reverted })

    const result = await syncChainFromHashes({ ...CONTEXT, client: c, storage, hashes: [hash(1)] })

    expect(result.found).toBe(0)
    expect(loadHistory(storage, { wallet: WALLET, chainId: 8453 })).toHaveLength(0)
    // Still screened: a reverted transaction stays reverted, so asking again is wasted work.
    expect(loadScreened(storage, { wallet: WALLET, chainId: 8453 }).get(hash(1))).toBe('other')
  })
})
