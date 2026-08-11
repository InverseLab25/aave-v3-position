import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

/**
 * DexDiscovery's own logic is token-list assembly and selection: which tokens each side offers,
 * which is selected by default, and what gets invalidated when the pair, amount or chain moves.
 * Quoting itself belongs to the adapters, which have their own coverage — so `getAdaptersForChain`
 * returns a stub here and these stay about the component's decisions.
 */
const mocks = vi.hoisted(() => ({
  useAavePositions: vi.fn(),
  useConnection: vi.fn(),
  useReadContract: vi.fn(),
  useBalance: vi.fn(),
  getAdaptersForChain: vi.fn(),
  getChainConfig: vi.fn(),
}))

vi.mock('../hooks/useAavePositions', () => ({ useAavePositions: mocks.useAavePositions }))
vi.mock('wagmi', () => ({
  useConnection: mocks.useConnection,
  useReadContract: mocks.useReadContract,
  useBalance: mocks.useBalance,
}))
vi.mock('../adapters', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getAdaptersForChain: mocks.getAdaptersForChain,
}))
vi.mock('../config/chains', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getChainConfig: mocks.getChainConfig,
}))
vi.mock('./ConfirmSwapModal', () => ({ ConfirmSwapModal: () => null }))

import { DexDiscovery } from './DexDiscovery'

const USER = '0x1111111111111111111111111111111111111111' as const
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F' as const

const supplied = (over: Record<string, unknown> = {}) => ({
  symbol: 'WETH',
  underlyingAsset: WETH,
  decimals: 18,
  priceInUsd: '3000',
  ...over,
})
const borrowed = (over: Record<string, unknown> = {}) => ({
  symbol: 'USDC',
  underlyingAsset: USDC,
  decimals: 6,
  priceInUsd: '1',
  ...over,
})

const chainConfig = (over: Record<string, unknown> = {}) => ({
  name: 'Ethereum',
  adapters: ['KyberSwap'],
  defaultTokens: [
    { underlyingAsset: WETH, symbol: 'WETH', decimals: 18 },
    { underlyingAsset: DAI, symbol: 'DAI', decimals: 18 },
  ],
  ...over,
})

const positions = (over: Record<string, unknown> = {}) => ({
  suppliedAssets: [],
  borrowedAssets: [],
  isConnected: true,
  chainId: 1,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useAavePositions.mockReturnValue(positions())
  mocks.useConnection.mockReturnValue({
    address: USER,
    chain: { nativeCurrency: { symbol: 'ETH', decimals: 18 } },
  })
  mocks.useReadContract.mockReturnValue({ data: undefined })
  mocks.useBalance.mockReturnValue({ data: undefined })
  mocks.getAdaptersForChain.mockReturnValue([
    { name: 'KyberSwap', getQuote: vi.fn().mockResolvedValue(null) },
  ])
  mocks.getChainConfig.mockReturnValue(chainConfig())
})

/** The two token dropdowns, in DOM order: sell side then buy side. */
const selects = () => screen.getAllByRole('combobox') as HTMLSelectElement[]
const fromSelect = () => selects()[0]
const toSelect = () => selects()[1]
const optionsOf = (el: HTMLSelectElement) => Array.from(el.options).map((o) => o.text)

describe('DexDiscovery — token list assembly', () => {
  it('offers the chain native currency alongside the configured defaults', () => {
    render(<DexDiscovery />)
    expect(optionsOf(fromSelect())).toEqual(['ETH', 'WETH', 'DAI'])
  })

  it('shows an unsupported-network notice instead of a swap form when no adapter serves the chain', () => {
    // Nothing can be routed there, so the whole card — token lists included — is withheld
    // rather than offering an invitation to a dead end.
    mocks.getChainConfig.mockReturnValue(chainConfig({ adapters: [] }))
    mocks.getAdaptersForChain.mockReturnValue([])
    render(<DexDiscovery />)

    expect(screen.getByText(/DEX aggregators are not supported/)).toBeTruthy()
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
  })

  it("derives the native symbol from the connected chain rather than assuming ether", () => {
    mocks.useConnection.mockReturnValue({
      address: USER,
      chain: { nativeCurrency: { symbol: 'POL', decimals: 18 } },
    })
    render(<DexDiscovery />)

    expect(optionsOf(fromSelect())[0]).toBe('POL')
  })

  it('falls back to un-wrapping the first default token when the chain is unknown', () => {
    // WETH -> ETH, WBNB -> BNB: the leading W is what distinguishes wrapped from native.
    mocks.useConnection.mockReturnValue({ address: USER, chain: undefined })
    mocks.getChainConfig.mockReturnValue(
      chainConfig({ defaultTokens: [{ underlyingAsset: WETH, symbol: 'WBNB', decimals: 18 }] }),
    )
    render(<DexDiscovery />)

    expect(optionsOf(fromSelect())[0]).toBe('BNB')
  })

  it('puts supplied assets first on the sell side and dedupes against the defaults', () => {
    // WETH is both supplied and a default; it must appear once, as the supplied entry.
    mocks.useAavePositions.mockReturnValue(positions({ suppliedAssets: [supplied()] }))
    render(<DexDiscovery />)

    expect(optionsOf(fromSelect())).toEqual(['WETH', 'ETH', 'DAI'])
  })

  it('puts borrowed assets first on the buy side', () => {
    mocks.useAavePositions.mockReturnValue(positions({ borrowedAssets: [borrowed()] }))
    render(<DexDiscovery />)

    expect(optionsOf(toSelect())[0]).toBe('USDC')
  })

  it('dedupes case-insensitively, since Aave and the config disagree on checksum casing', () => {
    mocks.useAavePositions.mockReturnValue(positions({
      suppliedAssets: [supplied({ underlyingAsset: WETH.toLowerCase(), symbol: 'WETH-supplied' })],
    }))
    render(<DexDiscovery />)

    const opts = optionsOf(fromSelect())
    expect(opts).toContain('WETH-supplied')
    expect(opts).not.toContain('WETH')
  })
})

describe('DexDiscovery — default selection', () => {
  it('never defaults both sides to the same token', () => {
    // The buy side skips whatever the sell side landed on, or the pair is unquotable on arrival.
    render(<DexDiscovery />)

    expect(fromSelect().value.toLowerCase()).not.toBe(toSelect().value.toLowerCase())
  })

  it('re-picks the buy side when the user selects the token it was already showing', () => {
    render(<DexDiscovery />)
    const target = toSelect().value

    fireEvent.change(fromSelect(), { target: { value: target } })

    expect(fromSelect().value.toLowerCase()).toBe(target.toLowerCase())
    expect(toSelect().value.toLowerCase()).not.toBe(target.toLowerCase())
  })
})

describe('DexDiscovery — direction swap', () => {
  it('exchanges the two sides and clears the amount', () => {
    // The amount was denominated in the old sell token; carrying it over would re-quote a
    // number that means something different now.
    render(<DexDiscovery />)
    const before = { from: fromSelect().value, to: toSelect().value }
    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '1.5' } })

    fireEvent.click(screen.getByLabelText('Swap tokens'))

    expect(fromSelect().value).toBe(before.to)
    expect(toSelect().value).toBe(before.from)
    expect((screen.getByPlaceholderText('0.0') as HTMLInputElement).value).toBe('')
  })
})

describe('DexDiscovery — chain change', () => {
  it('drops the user selections when the chain changes under them', () => {
    // Token addresses are chain-scoped: an override carried across would name a contract that
    // does not exist on the new chain.
    const { rerender } = render(<DexDiscovery />)
    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '2' } })
    fireEvent.change(toSelect(), { target: { value: DAI } })

    mocks.useAavePositions.mockReturnValue(positions({ chainId: 8453 }))
    mocks.getChainConfig.mockReturnValue(
      chainConfig({ defaultTokens: [{ underlyingAsset: USDC, symbol: 'USDbC', decimals: 6 }] }),
    )
    rerender(<DexDiscovery />)

    expect((screen.getByPlaceholderText('0.0') as HTMLInputElement).value).toBe('')
    expect(optionsOf(fromSelect())).toEqual(['ETH', 'USDbC'])
  })
})

describe('DexDiscovery — wallet balance', () => {
  it('reads an ERC-20 balance at the token decimals', () => {
    mocks.useAavePositions.mockReturnValue(positions({ suppliedAssets: [supplied()] }))
    mocks.useReadContract.mockReturnValue({ data: 1_500_000_000_000_000_000n })
    render(<DexDiscovery />)

    expect(screen.getByText(/1\.500000/)).toBeTruthy()
  })

  it('reads the native balance through useBalance rather than balanceOf', () => {
    // Native has no ERC-20 contract to call, so the balanceOf read stays disabled and would
    // otherwise report zero.
    mocks.useBalance.mockReturnValue({ data: { value: 2_000_000_000_000_000_000n, decimals: 18 } })
    render(<DexDiscovery />)

    expect(screen.getByText(/2\.000000/)).toBeTruthy()
  })
})
