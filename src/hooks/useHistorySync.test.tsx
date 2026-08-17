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
  useConfig: vi.fn(),
  useReadContracts: vi.fn(),
  watchEvent: vi.fn(),
  syncChain: vi.fn(),
  syncableChains: vi.fn(),
  clearAllCursors: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useConnection: mocks.useConnection,
  useConfig: mocks.useConfig,
  useReadContracts: mocks.useReadContracts,
}))
vi.mock('viem/actions', () => ({
  watchEvent: mocks.watchEvent,
  getBlock: vi.fn(),
  getBlockNumber: vi.fn(),
  getTransactionReceipt: vi.fn(),
}))
vi.mock('../lib/historySync', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  syncChain: mocks.syncChain,
}))
vi.mock('../config/chains', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  syncableChains: mocks.syncableChains,
}))
vi.mock('../lib/syncCursor', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  clearAllCursors: mocks.clearAllCursors,
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
  mocks.useConfig.mockReturnValue({ chains: [], getClient: () => ({}) })
  mocks.watchEvent.mockReturnValue(() => {})
  mocks.syncChain.mockResolvedValue({ scanned: { from: 1n, to: 2n }, found: 0 })
  mocks.syncableChains.mockReturnValue([
    { chainId: 8453, address: STRATEGIES, fromBlock: 49_831_780n },
  ])
  reservesLoaded()
})

describe('useHistorySync', () => {
  it('reads every chain the wallet could have a position on', async () => {
    mocks.syncableChains.mockReturnValue([
      { chainId: 8453, address: STRATEGIES, fromBlock: 49_831_780n },
      { chainId: 42161, address: STRATEGIES, fromBlock: 493_443_506n },
    ])
    reservesLoaded(2)

    renderHook(() => useHistorySync())

    await waitFor(() => expect(mocks.syncChain).toHaveBeenCalledTimes(2))
    expect(mocks.syncChain.mock.calls.map((c) => c[0].chainId).sort((a, b) => a - b)).toEqual([
      8453, 42161,
    ])
  })

  it('does nothing at all without a connected wallet', async () => {
    mocks.useConnection.mockReturnValue({ address: undefined })

    renderHook(() => useHistorySync())

    await waitFor(() => expect(mocks.watchEvent).not.toHaveBeenCalled())
    expect(mocks.syncChain).not.toHaveBeenCalled()
  })

  it('waits for the metadata that makes a recovered row readable', async () => {
    // Without it a backfilled row on a chain the panel is not viewing reads "1234 raw units"
    // against a bare address, and there is no second pass that comes back to name it.
    mocks.useReadContracts.mockReturnValue({ data: undefined })

    renderHook(() => useHistorySync())

    await waitFor(() => expect(mocks.watchEvent).toHaveBeenCalled())
    expect(mocks.syncChain).not.toHaveBeenCalled()
  })

  it('hands over the token names and the position tokens to hide', async () => {
    renderHook(() => useHistorySync())

    await waitFor(() => expect(mocks.syncChain).toHaveBeenCalled())
    const input = mocks.syncChain.mock.calls[0][0]
    expect(input.tokens[WETH.toLowerCase()]).toEqual({ symbol: 'WETH', decimals: 18 })
    expect(input.hidden).toEqual([A_WETH, D_WETH])
  })

  it('reports a failure rather than throwing it at the screen', async () => {
    // A rate-limited RPC must not take a position panel down with it.
    mocks.syncChain.mockRejectedValue(new Error('rate limited'))

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

  it('subscribes to both events, so either kind of position wakes it', async () => {
    renderHook(() => useHistorySync())

    await waitFor(() => expect(mocks.watchEvent).toHaveBeenCalledTimes(2))
    const names = mocks.watchEvent.mock.calls.map((c) => c[1].event.name)
    expect(names.sort()).toEqual(['PositionClosed', 'PositionOpened'])
    expect(mocks.watchEvent.mock.calls[0][1].args).toEqual({ user: WALLET })
  })

  it('re-reads the chain when a watched event lands', async () => {
    // The part standing in for a backend: a position opened on another device shows up here.
    renderHook(() => useHistorySync())
    await waitFor(() => expect(mocks.syncChain).toHaveBeenCalledTimes(1))

    mocks.watchEvent.mock.calls[0][1].onLogs([{}])

    await waitFor(() => expect(mocks.syncChain).toHaveBeenCalledTimes(2))
  })

  it('lets go of its subscriptions when it goes away', async () => {
    const unwatch = vi.fn()
    mocks.watchEvent.mockReturnValue(unwatch)

    const { unmount } = renderHook(() => useHistorySync())
    await waitFor(() => expect(mocks.watchEvent).toHaveBeenCalled())
    unmount()

    expect(unwatch).toHaveBeenCalledTimes(2)
  })

  it('forgets every cursor when asked to resync, and reads again', async () => {
    const { result } = renderHook(() => useHistorySync())
    await waitFor(() => expect(mocks.syncChain).toHaveBeenCalledTimes(1))

    result.current.resync()

    await waitFor(() => expect(mocks.syncChain).toHaveBeenCalledTimes(2))
    expect(mocks.clearAllCursors).toHaveBeenCalled()
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
