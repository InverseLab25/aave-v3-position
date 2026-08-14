import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import {
  ADOPTION_BAND_BPS,
  MIN_DELEGATION_REMAINING_S,
  browserStorage,
  canReuseDelegation,
  clearDelegation,
  delegationBlocker,
  delegationKey,
  isDelegationLive,
  loadDelegation,
  saveDelegation,
  withinAdoptionBand,
  type DelegationNeed,
  type DelegationStorage,
  type HeldDelegation,
} from './delegationCache'

const OWNER = '0x000000000000000000000000000000000000dEaD' as Address
const DEBT_ASSET = '0x4444444444444444444444444444444444444444' as Address
const V_DEBT = '0x5555555555555555555555555555555555555555' as Address
const STRATEGIES = '0x000000000000000000000000000000000000bEEF' as Address

const NOW = 1_800_000_000n

function held(over: Partial<HeldDelegation> = {}): HeldDelegation {
  return {
    chainId: 8453,
    owner: OWNER,
    debtAsset: DEBT_ASSET,
    debtToken: V_DEBT,
    delegatee: STRATEGIES,
    nonce: 7n,
    value: 1000n * 10n ** 6n,
    deadline: NOW + 1800n,
    signature: `0x${'ab'.repeat(65)}`,
    ...over,
  }
}

function need(over: Partial<DelegationNeed> = {}): DelegationNeed {
  return {
    chainId: 8453,
    owner: OWNER,
    debtAsset: DEBT_ASSET,
    debtToken: V_DEBT,
    delegatee: STRATEGIES,
    nonce: 7n,
    value: 1000n * 10n ** 6n,
    nowSeconds: NOW,
    ...over,
  }
}

function memoryStorage(seed: Record<string, string> = {}): DelegationStorage {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

describe('delegationBlocker', () => {
  it('reuses a signature that matches on every field and has time left', () => {
    expect(delegationBlocker(held(), need())).toBeNull()
    expect(canReuseDelegation(held(), need())).toBe(true)
  })

  it('refuses when nothing is held', () => {
    expect(delegationBlocker(null, need())).toBe('nothing held')
  })

  it.each([
    ['chain', { chainId: 1 }, /chain/],
    ['owner', { owner: '0x1111111111111111111111111111111111111111' as Address }, /owner/],
    ['debt asset', { debtAsset: '0x2222222222222222222222222222222222222222' as Address }, /debt asset/],
    ['debt token', { debtToken: '0x3333333333333333333333333333333333333333' as Address }, /debt token/],
    ['delegatee', { delegatee: '0x9999999999999999999999999999999999999999' as Address }, /delegatee/],
  ])('refuses when the %s changed', (_label, over, pattern) => {
    expect(delegationBlocker(held(), need(over))).toMatch(pattern)
  })

  it('refuses once the nonce has advanced, which is what proves the grant was spent', () => {
    // The delegation landed on chain. Reusing it now would revert inside `delegationWithSig`
    // rather than open anything, so this is the check that keeps a successful open from
    // being replayed out of storage.
    expect(delegationBlocker(held(), need({ nonce: 8n }))).toMatch(/already spent/)
  })

  it('refuses any borrow other than the exact signed one, in both directions', () => {
    // Coverage is not enough: the contract passes its own borrowAmount as the signed value, so a
    // signature over MORE fails to recover the signer just as surely as one over less.
    expect(delegationBlocker(held(), need({ value: 1001n * 10n ** 6n }))).toMatch(/borrow/)
    expect(delegationBlocker(held(), need({ value: 999n * 10n ** 6n }))).toMatch(/borrow/)
  })

  it('refuses a signature with too little validity left to survive inclusion', () => {
    const marginal = held({ deadline: NOW + MIN_DELEGATION_REMAINING_S })
    expect(delegationBlocker(marginal, need())).toMatch(/validity left/)

    const spare = held({ deadline: NOW + MIN_DELEGATION_REMAINING_S + 1n })
    expect(delegationBlocker(spare, need())).toBeNull()
  })

  it('treats addresses case-insensitively, since checksums differ between sources', () => {
    expect(delegationBlocker(held({ owner: OWNER.toLowerCase() as Address }), need())).toBeNull()
  })
})

describe('isDelegationLive', () => {
  it('tracks the same margin the blocker enforces', () => {
    expect(isDelegationLive(held({ deadline: NOW + MIN_DELEGATION_REMAINING_S }), NOW)).toBe(false)
    expect(isDelegationLive(held({ deadline: NOW + MIN_DELEGATION_REMAINING_S + 1n }), NOW)).toBe(true)
  })
})

describe('withinAdoptionBand', () => {
  it('adopts a signature whose borrow is inside the band', () => {
    const solved = 1000n * 10n ** 6n
    const edge = solved + (solved * ADOPTION_BAND_BPS) / 10000n
    expect(withinAdoptionBand(edge, solved)).toBe(true)
    expect(withinAdoptionBand(edge + 10n ** 6n, solved)).toBe(false)
  })

  it('measures the gap in both directions', () => {
    const solved = 1000n * 10n ** 6n
    expect(withinAdoptionBand(solved - (solved * ADOPTION_BAND_BPS) / 10000n, solved)).toBe(true)
    expect(withinAdoptionBand(solved / 2n, solved)).toBe(false)
  })

  it('refuses to adopt against a zero or negative reference', () => {
    expect(withinAdoptionBand(0n, 1000n)).toBe(false)
    expect(withinAdoptionBand(1000n, 0n)).toBe(false)
  })
})

describe('storage', () => {
  it('round-trips a signature through storage with its bigints intact', () => {
    const storage = memoryStorage()
    const original = held()
    saveDelegation(storage, original)

    expect(loadDelegation(storage, delegationKey(original))).toEqual(original)
  })

  it('round-trips the tolerance the signature was taken at', () => {
    // The pin is judged against a seed computed at THIS tolerance, not at whatever the form
    // currently shows — so it has to survive the reload that a fresh mount performs.
    const storage = memoryStorage()
    const original = held({ slippageBps: 10n })
    saveDelegation(storage, original)

    expect(loadDelegation(storage, delegationKey(original))?.slippageBps).toBe(10n)
  })

  it('reads an entry written before the tolerance was recorded', () => {
    // Entries already in a user's browser have no `slippageBps`. Rejecting them would throw away
    // a live signature and re-prompt for nothing.
    const key = delegationKey(held())
    const legacy = JSON.stringify({
      chainId: 8453,
      owner: OWNER,
      debtAsset: DEBT_ASSET,
      debtToken: V_DEBT,
      delegatee: STRATEGIES,
      nonce: '7',
      value: (3000n * 10n ** 6n).toString(),
      deadline: (NOW + 600n).toString(),
      signature: `0x${'ab'.repeat(65)}`,
    })

    const loaded = loadDelegation(memoryStorage({ [key]: legacy }), key)

    expect(loaded?.value).toBe(3000n * 10n ** 6n)
    expect(loaded?.slippageBps).toBeUndefined()
  })

  it('scopes entries by chain, owner and debt asset', () => {
    const storage = memoryStorage()
    saveDelegation(storage, held())

    const otherOwner = delegationKey({
      chainId: 8453, owner: '0x1111111111111111111111111111111111111111' as Address,
      debtAsset: DEBT_ASSET,
    })
    expect(loadDelegation(storage, otherOwner)).toBeNull()
  })

  it('forgets a cleared signature', () => {
    const storage = memoryStorage()
    saveDelegation(storage, held())
    clearDelegation(storage, delegationKey(held()))

    expect(loadDelegation(storage, delegationKey(held()))).toBeNull()
  })

  it('reads a corrupt or half-written entry as nothing held', () => {
    const key = delegationKey(held())
    expect(loadDelegation(memoryStorage({ [key]: 'not json' }), key)).toBeNull()
    expect(loadDelegation(memoryStorage({ [key]: '{"chainId":8453}' }), key)).toBeNull()
    // A value that survives the shape check but not BigInt().
    expect(loadDelegation(
      memoryStorage({ [key]: JSON.stringify({ ...held(), nonce: 'x', value: '1', deadline: '1' }) }),
      key,
    )).toBeNull()
  })

  it('degrades to nothing held when storage is absent or throws', () => {
    const hostile: DelegationStorage = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('quota') },
      removeItem: () => { throw new Error('blocked') },
    }
    expect(loadDelegation(null, 'k')).toBeNull()
    expect(loadDelegation(hostile, 'k')).toBeNull()
    // Neither of these may throw: a signature that cannot be cached is a wallet prompt, not a
    // broken open.
    expect(() => saveDelegation(hostile, held())).not.toThrow()
    expect(() => saveDelegation(null, held())).not.toThrow()
    expect(() => clearDelegation(hostile, 'k')).not.toThrow()
  })

  it('exposes the browser store without touching it when there is none', () => {
    expect(browserStorage()).not.toBeUndefined()
  })
})
