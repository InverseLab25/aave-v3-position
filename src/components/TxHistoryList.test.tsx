import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { Address, Hex } from 'viem'
import { TxHistoryList } from './TxHistoryList'
import { appendHistory, type TxHistoryEntry } from '../lib/txHistory'

const WALLET = '0x1111111111111111111111111111111111111111' as Address
const OTHER = '0x2222222222222222222222222222222222222222' as Address
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address

function installStorage() {
  const map = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
    configurable: true,
  })
}

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex

function entry(over: Partial<TxHistoryEntry> = {}): TxHistoryEntry {
  return {
    hash: hash(1),
    chainId: 8453,
    wallet: WALLET,
    kind: 'open',
    at: 1_800_000_000_000,
    swap: {
      srcToken: USDC,
      dstToken: WETH,
      srcSymbol: 'USDC',
      srcDecimals: 6,
      dstSymbol: 'WETH',
      dstDecimals: 18,
      spentAmount: 3405_100000n,
      returnAmount: 10n ** 18n,
    },
    rate: '0.000293',
    fill: { delta: -2_700000n, percent: -0.0792, belowFloor: false },
    deltas: [{ token: WETH, symbol: 'aWETH', decimals: 18, delta: 10n ** 18n }],
    ...over,
  }
}

const show = (over: { wallet?: Address; chainId?: number } = {}) =>
  render(<TxHistoryList wallet={over.wallet ?? WALLET} chainId={over.chainId ?? 8453} />)

describe('TxHistoryList', () => {
  beforeEach(installStorage)

  it('renders nothing when this wallet has no history yet', () => {
    const { container } = show()

    expect(container.firstChild).toBeNull()
  })

  it('counts what it has without being opened', () => {
    appendHistory(localStorage, entry({ hash: hash(1) }))
    appendHistory(localStorage, entry({ hash: hash(2) }))

    show()

    expect(screen.getByText(/Recent activity \(2\)/)).toBeTruthy()
  })

  it('shows the rate each transaction filled at, once opened', () => {
    appendHistory(localStorage, entry({ rate: '3405.1' }))
    show()

    fireEvent.click(screen.getByRole('button', { name: /recent activity/i }))

    expect(screen.getByText(/1 USDC = 3,405.1 WETH/)).toBeTruthy()
  })

  it('says which flow each row came from', () => {
    appendHistory(localStorage, entry({ hash: hash(1), kind: 'close' }))
    show()

    fireEvent.click(screen.getByRole('button', { name: /recent activity/i }))

    expect(screen.getByText('Close')).toBeTruthy()
  })

  it('leaves out another wallet, and the same wallet on another chain', () => {
    appendHistory(localStorage, entry({ hash: hash(1), wallet: OTHER }))
    appendHistory(localStorage, entry({ hash: hash(2), chainId: 42161 }))

    const { container } = show()

    expect(container.firstChild).toBeNull()
  })

  it('links each row to the explorer', () => {
    appendHistory(localStorage, entry())
    show()

    fireEvent.click(screen.getByRole('button', { name: /recent activity/i }))

    expect(screen.getByRole('link').getAttribute('href')).toContain(hash(1))
  })

  it('renders a row whose swap was never decoded', () => {
    // A receipt with no Swapped log still moved collateral and debt, and the row is worth keeping.
    appendHistory(localStorage, entry({ swap: null, rate: null, fill: null }))
    show()

    fireEvent.click(screen.getByRole('button', { name: /recent activity/i }))

    expect(screen.getByText(/no swap recorded/i)).toBeTruthy()
  })

  it('appears when a transaction is recorded while it is already on screen', () => {
    // The row is written from an effect — after the render that would have shown it — so a list
    // that reads storage once shows nothing until a reload.
    const { container } = show()
    expect(container.firstChild).toBeNull()

    act(() => {
      appendHistory(localStorage, entry())
    })

    expect(screen.queryByText(/Recent activity/)).toBeTruthy()
  })
})
