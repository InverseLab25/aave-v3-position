import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { SCREEN_KEY, loadScreened, recordScreened, unscreened } from './screenCache'
import type { DelegationStorage } from './delegationCache'

const WALLET = '0x253FaC550bae1EE9B4680b3735DC38a3f6eCd600' as Address
const OTHER = '0x1111111111111111111111111111111111111111' as Address
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex

function memoryStorage(): DelegationStorage {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

const scope = { wallet: WALLET, chainId: 8453 }

describe('screenCache', () => {
  it('remembers that a hash was looked at, and what it turned out to be', () => {
    const storage = memoryStorage()

    recordScreened(storage, scope, [
      { hash: hash(1), verdict: 'strategies' },
      { hash: hash(2), verdict: 'other' },
    ])

    const seen = loadScreened(storage, scope)
    expect(seen.get(hash(1))).toBe('strategies')
    expect(seen.get(hash(2))).toBe('other')
  })

  it('reports which hashes still need a receipt', () => {
    // The whole point: on the second load nothing is fetched.
    const storage = memoryStorage()
    recordScreened(storage, scope, [{ hash: hash(1), verdict: 'other' }])

    expect(unscreened(storage, scope, [hash(1), hash(2)])).toEqual([hash(2)])
    expect(unscreened(storage, scope, [hash(1)])).toEqual([])
  })

  it('matches a hash whatever case it arrives in', () => {
    // The indexer and the RPC do not agree on casing, and a miss here costs a refetch every load.
    const storage = memoryStorage()
    recordScreened(storage, scope, [{ hash: hash(0xabc), verdict: 'other' }])

    expect(unscreened(storage, scope, [hash(0xabc).toUpperCase() as Hex])).toEqual([])
  })

  it('keeps one wallet-and-chain apart from another', () => {
    const storage = memoryStorage()
    recordScreened(storage, scope, [{ hash: hash(1), verdict: 'other' }])

    expect(unscreened(storage, { wallet: OTHER, chainId: 8453 }, [hash(1)])).toEqual([hash(1)])
    expect(unscreened(storage, { wallet: WALLET, chainId: 42161 }, [hash(1)])).toEqual([hash(1)])
  })

  it('adds to what is already there rather than replacing it', () => {
    const storage = memoryStorage()
    recordScreened(storage, scope, [{ hash: hash(1), verdict: 'other' }])
    recordScreened(storage, scope, [{ hash: hash(2), verdict: 'strategies' }])

    expect(loadScreened(storage, scope).size).toBe(2)
  })

  it('treats a corrupted store as an empty one rather than throwing', () => {
    const storage = memoryStorage()
    storage.setItem(SCREEN_KEY, 'not json')

    expect(loadScreened(storage, scope).size).toBe(0)
    expect(unscreened(storage, scope, [hash(1)])).toEqual([hash(1)])
  })

  it('does nothing at all without a store', () => {
    expect(() => recordScreened(null, scope, [{ hash: hash(1), verdict: 'other' }])).not.toThrow()
    expect(unscreened(null, scope, [hash(1)])).toEqual([hash(1)])
  })
})

describe('clearScreened', () => {
  it('makes every hash look unexamined again', async () => {
    const { clearScreened } = await import('./screenCache')
    const storage = memoryStorage()
    recordScreened(storage, scope, [{ hash: hash(1), verdict: 'other' }])

    clearScreened(storage)

    expect(unscreened(storage, scope, [hash(1)])).toEqual([hash(1)])
  })
})
