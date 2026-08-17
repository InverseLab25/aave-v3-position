import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { Address } from 'viem'

const WALLET = '0x1111111111111111111111111111111111111111' as Address
const STRATEGIES = '0x75b1ab12e47aaee4e1033100de1992e735c32c9c' as Address
const WETH = '0x4200000000000000000000000000000000000006' as Address
const A_WETH = '0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8' as Address
const D_WETH = '0x24e6e0795b3c7c71D965fCc4f371803d1c1DcA1E' as Address

const mocks = vi.hoisted(() => ({
  useConnection: vi.fn(),
  useChainId: vi.fn(),
  useConfig: vi.fn(),
  useReadContracts: vi.fn(),
  syncChainFromHashes: vi.fn(),
  fetchUserTxHashes: vi.fn(),
  syncableChains: vi.fn(),
  clearScreened: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useConnection: mocks.useConnection,
  useChainId: mocks.useChainId,
  useConfig: mocks.useConfig,
  useReadContracts: mocks.useReadContracts,
}))
vi.mock('viem/actions', () => ({
  getBlock: vi.fn(),
  getTransactionReceipt: vi.fn(),
}))
vi.mock('../lib/hashSync', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  syncChainFromHashes: mocks.syncChainFromHashes,
}))
vi.mock('../lib/aaveTxHashes', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchUserTxHashes: mocks.fetchUserTxHashes,
}))
vi.mock('../config/chains', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  syncableChains: mocks.syncableChains,
}))
vi.mock('../lib/screenCache', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  clearScreened: mocks.clearScreened,
}))

import { useHistorySync } from './useHistorySync'

/** One reserve, in the shape `getReservesData` answers with. */
const reserve = {
  symbol: 'WETH',
  decimals: 18n,
  underlyingAsset: WETH,
  aTokenAddress: A_WETH,
  variableDebtTokenAddress: D_WETH,
}

function reservesLoaded(chains = 1) {
  mocks.useReadContracts.mockReturnValue({
    data: Array.from({ length: chains }, () => ({
      status: 'success',
      result: [[reserve], {}],
    })),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useConnection.mockReturnValue({ address: WALLET })
  mocks.useChainId.mockReturnValue(8453)
  mocks.useConfig.mockReturnValue({ chains: [], getClient: () => ({}) })
  mocks.syncChainFromHashes.mockResolvedValue({ examined: 0, found: 0 })
  mocks.fetchUserTxHashes.mockResolvedValue([])
  mocks.syncableChains.mockReturnValue([
    { chainId: 8453, address: STRATEGIES, fromBlock: 49_831_780n },
  ])
  reservesLoaded()
})

describe('useHistorySync', () => {
  it('reads only the chain the wallet is connected to', async () => {
    // Syncing every deployment meant a wallet on Base paying for Arbitrum reads it would never
    // look at. The panel shows one chain's position and one chain's history at a time, and
    // switching chains re-runs this — which is when the other chain's history is actually wanted.
    mocks.syncableChains.mockReturnValue([
      { chainId: 8453, address: STRATEGIES, fromBlock: 49_831_780n },
      { chainId: 42161, address: STRATEGIES, fromBlock: 493_443_506n },
    ])
    reservesLoaded(2)

    renderHook(() => useHistorySync())

    await waitFor(() => expect(mocks.syncChainFromHashes).toHaveBeenCalledTimes(1))
    expect(mocks.syncChainFromHashes.mock.calls[0][0].chainId).toBe(8453)
  })

  it('follows the wallet to another chain', async () => {
    mocks.syncableChains.mockReturnValue([
      { chainId: 8453, address: STRATEGIES, fromBlock: 49_831_780n },
      { chainId: 42161, address: STRATEGIES, fromBlock: 493_443_506n },
    ])
    mocks.useChainId.mockReturnValue(42161)
    reservesLoaded(2)

    renderHook(() => useHistorySync())

    await waitFor(() => expect(mocks.syncChainFromHashes).toHaveBeenCalledTimes(1))
    expect(mocks.syncChainFromHashes.mock.calls[0][0].chainId).toBe(42161)
  })

  it('does nothing at all without a connected wallet', async () => {
    mocks.useConnection.mockReturnValue({ address: undefined })

    renderHook(() => useHistorySync())

    await waitFor(() => expect(mocks.syncChainFromHashes).not.toHaveBeenCalled())
  })

  it('waits for the metadata that makes a recovered row readable', async () => {
    // Without it a backfilled row on a chain the panel is not viewing reads "1234 raw units"
    // against a bare address, and there is no second pass that comes back to name it.
    mocks.useReadContracts.mockReturnValue({ data: undefined })

    renderHook(() => useHistorySync())

    await waitFor(() => expect(mocks.syncChainFromHashes).not.toHaveBeenCalled())
  })

  it('hands over the token names and the position tokens to hide', async () => {
    renderHook(() => useHistorySync())

    await waitFor(() => expect(mocks.syncChainFromHashes).toHaveBeenCalled())
    const input = mocks.syncChainFromHashes.mock.calls[0][0]
    expect(input.tokens[WETH.toLowerCase()]).toEqual({ symbol: 'WETH', decimals: 18 })
    expect(input.hidden).toEqual([A_WETH, D_WETH])
  })

  it('reports a failure rather than throwing it at the screen', async () => {
    // A rate-limited RPC must not take a position panel down with it.
    mocks.syncChainFromHashes.mockRejectedValue(new Error('rate limited'))

    const { result } = renderHook(() => useHistorySync())

    await waitFor(() => expect(result.current.status.error).toBe('rate limited'))
    expect(result.current.status.scanning).toBe(false)
  })

  it('clears the error and stops scanning once a chain succeeds', async () => {
    const { result } = renderHook(() => useHistorySync())

    await waitFor(() => expect(result.current.status.syncedAt).not.toBeNull())
    expect(result.current.status.error).toBeNull()
    expect(result.current.status.scanning).toBe(false)
  })

  it('forgets every verdict when asked to resync, and reads again', async () => {
    const { result } = renderHook(() => useHistorySync())
    await waitFor(() => expect(mocks.syncChainFromHashes).toHaveBeenCalledTimes(1))

    result.current.resync()

    await waitFor(() => expect(mocks.syncChainFromHashes).toHaveBeenCalledTimes(2))
    // There is no cursor to rewind any more. What stands between a user and a fresh read of the
    // chain is the screen cache, so that is what Resync clears.
    expect(mocks.clearScreened).toHaveBeenCalled()
  })

  it('survives a chain it cannot get a client for', async () => {
    mocks.useConfig.mockReturnValue({
      chains: [],
      getClient: () => {
        throw new Error('chain not configured')
      },
    })

    const { result } = renderHook(() => useHistorySync())

    await waitFor(() => expect(result.current.status.error).toBe('chain not configured'))
  })
})
