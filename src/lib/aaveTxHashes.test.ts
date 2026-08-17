import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import { MAX_HISTORY_PAGES, fetchUserTxHashes } from './aaveTxHashes'

const USER = '0x253FaC550bae1EE9B4680b3735DC38a3f6eCd600' as Address
const MARKET = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' as Address
const req = { user: USER, chainId: 8453, market: MARKET }

const page = (hashes: string[], next: string | null = null) => ({
  ok: true,
  json: async () => ({
    data: { userTransactionHistory: { items: hashes.map((txHash) => ({ txHash })), pageInfo: { next } } },
  }),
})

afterEach(() => vi.unstubAllGlobals())

describe('fetchUserTxHashes', () => {
  it('collapses one transaction reported several times into one hash', async () => {
    // A leveraged open is a supply, a borrow and a second supply — three rows, one receipt to read.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page(['0xaa', '0xaa', '0xbb'])))

    expect(await fetchUserTxHashes(req)).toEqual(['0xaa', '0xbb'])
  })

  it('matches duplicates across casing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page(['0xAA', '0xaa'])))

    expect(await fetchUserTxHashes(req)).toEqual(['0xAA'])
  })

  it('follows the cursor to the end', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(['0xaa'], 'cursor-1'))
      .mockResolvedValueOnce(page(['0xbb'], null))
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchUserTxHashes(req)).toEqual(['0xaa', '0xbb'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops following an endless cursor', async () => {
    // An unbounded loop against a remote API is a worse failure than a truncated list.
    const fetchMock = vi.fn().mockResolvedValue(page(['0xaa'], 'always-more'))
    vi.stubGlobal('fetch', fetchMock)

    await fetchUserTxHashes(req)

    expect(fetchMock).toHaveBeenCalledTimes(MAX_HISTORY_PAGES)
  })

  it('throws rather than returning a short list', async () => {
    // `hashSync` records a verdict per hash it examined. A silently truncated list would let it
    // record nothing for transactions it never saw, and never look again.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }))

    await expect(fetchUserTxHashes(req)).rejects.toThrow('429')
  })

  it('reports a GraphQL-level error too', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ errors: [{ message: 'unknown market' }] }),
    }))

    await expect(fetchUserTxHashes(req)).rejects.toThrow('unknown market')
  })

  it('asks for the movements a close appears as, not just an open', async () => {
    // Verified against a real Base account: its close showed up as a Repay and NOTHING else, so a
    // query narrowed to supply and borrow found two of its three positions and silently lost the
    // one that would have reset the cost basis.
    const fetchMock = vi.fn().mockResolvedValue(page([]))
    vi.stubGlobal('fetch', fetchMock)

    await fetchUserTxHashes(req)

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body).query
    expect(sent).toContain('UserSupplyTransaction')
    expect(sent).toContain('UserBorrowTransaction')
    expect(sent).toContain('UserWithdrawTransaction')
    expect(sent).toContain('UserRepayTransaction')
  })

  it('does not ask for movements that can never be ours', async () => {
    // A standalone collateral toggle and somebody else's liquidation both screen out, so fetching
    // their receipts was a request with a guaranteed negative verdict.
    const fetchMock = vi.fn().mockResolvedValue(page([]))
    vi.stubGlobal('fetch', fetchMock)

    await fetchUserTxHashes(req)

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body).query
    expect(sent).not.toContain('UsageAsCollateral')
    expect(sent).not.toContain('LiquidationCall')
  })

  it('has nothing to say about a wallet with no Aave history', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page([])))

    expect(await fetchUserTxHashes(req)).toEqual([])
  })
})
