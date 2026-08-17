import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import {
  SYNC_CURSOR_KEY,
  clearAllCursors,
  clearCursor,
  loadCursor,
  saveCursor,
} from './syncCursor'
import type { DelegationStorage } from './delegationCache'

const WALLET = '0x1111111111111111111111111111111111111111' as Address
const OTHER_WALLET = '0x2222222222222222222222222222222222222222' as Address

function memoryStorage(seed: Record<string, string> = {}): DelegationStorage {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

const BASE = { chainId: 8453, wallet: WALLET }

describe('syncCursor', () => {
  it('reads back the block it was told to remember', () => {
    const storage = memoryStorage()

    saveCursor(storage, BASE, 49_831_780n)

    expect(loadCursor(storage, BASE)).toBe(49_831_780n)
  })

  it('has no cursor for a wallet and chain it has never scanned', () => {
    expect(loadCursor(memoryStorage(), BASE)).toBeNull()
  })

  it('keeps a cursor per chain, so one scan does not skip another chain', () => {
    // A shared cursor would have Arbitrum resume from Base's block number, which on these two
    // chains means skipping roughly four hundred million blocks of history.
    const storage = memoryStorage()

    saveCursor(storage, { chainId: 8453, wallet: WALLET }, 100n)
    saveCursor(storage, { chainId: 42161, wallet: WALLET }, 900n)

    expect(loadCursor(storage, { chainId: 8453, wallet: WALLET })).toBe(100n)
    expect(loadCursor(storage, { chainId: 42161, wallet: WALLET })).toBe(900n)
  })

  it('keeps a cursor per wallet', () => {
    const storage = memoryStorage()

    saveCursor(storage, { chainId: 8453, wallet: WALLET }, 100n)

    expect(loadCursor(storage, { chainId: 8453, wallet: OTHER_WALLET })).toBeNull()
  })

  it('finds the cursor whatever case the wallet is given in', () => {
    const storage = memoryStorage()

    saveCursor(storage, BASE, 100n)

    expect(loadCursor(storage, { chainId: 8453, wallet: WALLET.toUpperCase() as Address })).toBe(100n)
  })

  it('never moves a cursor backwards', () => {
    // Two chains sync concurrently and a slow one can report an older head after a fast one has
    // already advanced. Rewinding would re-scan a range that was already merged — harmless — but
    // it would also re-open a window the prune has authority over, on stale evidence.
    const storage = memoryStorage()

    saveCursor(storage, BASE, 500n)
    saveCursor(storage, BASE, 400n)

    expect(loadCursor(storage, BASE)).toBe(500n)
  })

  it('forgets one scope without disturbing the others', () => {
    const storage = memoryStorage()
    saveCursor(storage, { chainId: 8453, wallet: WALLET }, 100n)
    saveCursor(storage, { chainId: 42161, wallet: WALLET }, 900n)

    clearCursor(storage, { chainId: 8453, wallet: WALLET })

    expect(loadCursor(storage, { chainId: 8453, wallet: WALLET })).toBeNull()
    expect(loadCursor(storage, { chainId: 42161, wallet: WALLET })).toBe(900n)
  })

  it('forgets everything, so a resync starts from the deployment again', () => {
    const storage = memoryStorage()
    saveCursor(storage, { chainId: 8453, wallet: WALLET }, 100n)
    saveCursor(storage, { chainId: 42161, wallet: WALLET }, 900n)

    clearAllCursors(storage)

    expect(loadCursor(storage, { chainId: 8453, wallet: WALLET })).toBeNull()
    expect(loadCursor(storage, { chainId: 42161, wallet: WALLET })).toBeNull()
  })

  it('reads a corrupt payload as no cursor rather than throwing', () => {
    // A cursor that cannot be read costs one full re-scan. A cursor that throws costs the panel.
    expect(loadCursor(memoryStorage({ [SYNC_CURSOR_KEY]: 'not json' }), BASE)).toBeNull()
    expect(loadCursor(memoryStorage({ [SYNC_CURSOR_KEY]: '[1,2,3]' }), BASE)).toBeNull()
    expect(loadCursor(memoryStorage({ [SYNC_CURSOR_KEY]: '{"8453:x":"nope"}' }), BASE)).toBeNull()
  })

  it('survives an absent store and one that refuses to be written to', () => {
    const full: DelegationStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {},
    }

    expect(loadCursor(null, BASE)).toBeNull()
    expect(() => saveCursor(null, BASE, 1n)).not.toThrow()
    expect(() => saveCursor(full, BASE, 1n)).not.toThrow()
    expect(() => clearCursor(null, BASE)).not.toThrow()
    expect(() => clearAllCursors(null)).not.toThrow()
  })
})
