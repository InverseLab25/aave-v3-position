import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { Address, Hex } from 'viem'
import { TxHistoryList } from './TxHistoryList'
import { appendHistory, type TxHistoryEntry } from '../lib/txHistory'
import type { HistorySync, HistorySyncStatus } from '../hooks/useHistorySync'

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
    source: 'live',
    blockNumber: null,
    ...over,
  }
}

const show = (
  over: {
    wallet?: Address
    chainId?: number
    sync?: HistorySync
    realizedByTx?: Record<string, number>
  } = {},
) =>
  render(
    <TxHistoryList
      wallet={over.wallet ?? WALLET}
      chainId={over.chainId ?? 8453}
      sync={over.sync}
      realizedByTx={over.realizedByTx}
    />,
  )

const sync = (over: Partial<HistorySyncStatus> = {}, resync = () => {}): HistorySync => ({
  status: { scanning: false, error: null, syncedAt: null, ...over },
  resync,
})

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
    appendHistory(localStorage, entry())
    show()

    fireEvent.click(screen.getByRole('button', { name: /recent activity/i }))

    // Stable in, volatile out, so the volatile side is quoted by default.
    expect(screen.getByText(/1 WETH = 3,405.1 USDC/)).toBeTruthy()
  })

  it('inverts the rate from the amounts, not from the recorded string', () => {
    // Arbitrum 0x4ed0dd94…: 67,754.40695 USDT for 36.112335215858211266 WETH. `rate` was recorded
    // at a six-decimal scale, which left 0.000532 — and inverting THAT prices the fill at
    // 1,879.6992 rather than the 1,876.2123 the amounts themselves say.
    appendHistory(
      localStorage,
      entry({
        swap: {
          srcToken: USDC,
          dstToken: WETH,
          srcSymbol: 'USDT',
          srcDecimals: 6,
          dstSymbol: 'WETH',
          dstDecimals: 18,
          spentAmount: 67_754_406_950n,
          returnAmount: 36_112_335_215_858_211_266n,
        },
        rate: '0.000532',
      }),
    )
    show()

    fireEvent.click(screen.getByRole('button', { name: /recent activity/i }))

    expect(screen.getByText(/1 WETH = 1,876.2123 USDT/)).toBeTruthy()
  })

  it('quotes the other direction when the rate is flipped', () => {
    appendHistory(localStorage, entry())
    show()

    fireEvent.click(screen.getByRole('button', { name: /recent activity/i }))
    fireEvent.click(screen.getByRole('button', { name: /swap rate direction/i }))

    expect(screen.getByText(/1 USDC = 0.000293677 WETH/)).toBeTruthy()
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

  it('shows no slippage badge when the fill matched the quote exactly', () => {
    // A delta of zero rendered "+0.000000 WETH" — a badge whose content is that nothing happened.
    appendHistory(localStorage, entry({ fill: { delta: 0n, percent: 0, belowFloor: false } }))
    show()
    expand()

    expect(screen.queryByText(/0\.000000 WETH/)).toBeNull()
  })

  it('scrolls the row rather than the page when there is no room for it', () => {
    // Five nowrap columns give the row a hard minimum near 624px. Without a scroller here the
    // whole page went sideways on a narrow viewport.
    appendHistory(localStorage, entry())
    const { container } = show()
    expand()

    const scroller = [...container.querySelectorAll<HTMLElement>('div')].find(
      (d) => d.style.overflowX === 'auto',
    )
    expect(scroller).toBeTruthy()
  })

  /** `n` recorded transactions, newest first — hash(0) is the newest. */
  const seed = (n: number) => {
    for (let i = n - 1; i >= 0; i--) appendHistory(localStorage, entry({ hash: hash(i), at: 1000 - i }))
  }

  const expand = () => fireEvent.click(screen.getByRole('button', { name: /recent activity/i }))

  it('shows only the newest five at a time', () => {
    seed(12)
    show()

    expand()

    expect(screen.getAllByText(/^(Open|Close)$/)).toHaveLength(5)
    expect(screen.getByText(/1–5 of 12/)).toBeTruthy()
  })

  it('pages on to the next five', () => {
    seed(12)
    show()
    expand()

    fireEvent.click(screen.getByRole('button', { name: /next/i }))

    expect(screen.getByText(/6–10 of 12/)).toBeTruthy()
    expect(screen.getAllByText(/^(Open|Close)$/)).toHaveLength(5)
  })

  it('shows the remainder on the last page and stops there', () => {
    seed(12)
    show()
    expand()

    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    fireEvent.click(screen.getByRole('button', { name: /next/i }))

    expect(screen.getByText(/11–12 of 12/)).toBeTruthy()
    expect(screen.getAllByText(/^(Open|Close)$/)).toHaveLength(2)
    expect((screen.getByRole('button', { name: /next/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('cannot page back from the first page', () => {
    seed(12)
    show()
    expand()

    expect((screen.getByRole('button', { name: /previous/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers no paging when everything fits on one page', () => {
    seed(3)
    show()
    expand()

    expect(screen.queryByRole('button', { name: /next/i })).toBeNull()
    expect(screen.queryByText(/of 3/)).toBeNull()
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

describe('TxHistoryList sync status', () => {
  beforeEach(installStorage)

  it('says nothing about syncing when nothing is happening', () => {
    appendHistory(localStorage, entry())

    show({ sync: sync() })

    expect(screen.queryByText(/Checking the chain/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Resync/ })).toBeNull()
  })

  it('says so while it is reading the chain', () => {
    appendHistory(localStorage, entry())

    show({ sync: sync({ scanning: true }) })

    expect(screen.getByText(/Checking the chain/)).toBeTruthy()
  })

  it('shows the panel for a wallet with no rows yet when the sync failed', () => {
    // Otherwise the one user who most needs the Resync button — nothing recovered, and no idea
    // why — is shown an empty screen with no way to try again.
    show({ sync: sync({ error: 'rate limited' }) })

    expect(screen.getByText(/rate limited/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Resync/ })).toBeTruthy()
  })

  it('still renders nothing for a wallet with no rows and no trouble', () => {
    const { container } = show({ sync: sync() })

    expect(container.firstChild).toBeNull()
  })

  it('offers a resync once opened', () => {
    appendHistory(localStorage, entry())
    let asked = 0

    show({ sync: sync({}, () => asked++) })
    fireEvent.click(screen.getByText(/Recent activity/))
    fireEvent.click(screen.getByRole('button', { name: /Resync/ }))

    expect(asked).toBe(1)
  })

  it('works with no sync wired up at all', () => {
    appendHistory(localStorage, entry())

    show()

    expect(screen.getByText(/Recent activity \(1\)/)).toBeTruthy()
  })

  it('reports what a close settled at, next to the close', () => {
    appendHistory(localStorage, entry({ hash: hash(7), kind: 'close' }))
    show({ realizedByTx: { [hash(7)]: 39_224.79 } })
    fireEvent.click(screen.getByText(/Recent activity/))

    expect(screen.getByText('+$39,224.79')).toBeTruthy()
  })

  it('marks a loss with a minus that lines up under a digit', () => {
    appendHistory(localStorage, entry({ hash: hash(8), kind: 'close' }))
    show({ realizedByTx: { [hash(8)]: -476.34 } })
    fireEvent.click(screen.getByText(/Recent activity/))

    expect(screen.getByText('\u2212$476.34')).toBeTruthy()
  })

  it('settles nothing on an open, whatever the ledger says about that hash', () => {
    // An open establishes a cost basis. A figure here would be an opinion about a position that
    // is still running, which is exactly what the Price column already reports.
    appendHistory(localStorage, entry({ hash: hash(9), kind: 'open' }))
    show({ realizedByTx: { [hash(9)]: 1_000 } })
    fireEvent.click(screen.getByText(/Recent activity/))

    expect(screen.queryByText('+$1,000.00')).toBeNull()
  })

  it('shows no figure at all for a close the ledger has not priced', () => {
    // Absent while Aave's indexer is still answering. "Made nothing" and "not worked out yet" are
    // different statements and a zero would say the first.
    appendHistory(localStorage, entry({ hash: hash(10), kind: 'close' }))
    show()
    fireEvent.click(screen.getByText(/Recent activity/))

    expect(screen.queryByText(/^[+\u2212]\$/)).toBeNull()
  })

})
