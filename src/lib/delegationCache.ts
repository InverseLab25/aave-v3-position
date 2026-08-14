/**
 * A credit-delegation signature held between attempts, and the rules for spending it again.
 *
 * The open flow's failure mode is a stale aggregator route: the calldata is built once and the
 * position is submitted against it minutes later, which reverts. Re-quoting before every send
 * fixes that, but on its own it makes every retry cost another wallet prompt — the delegation is
 * taken inside `execute`, so a failed send throws the signature away with it.
 *
 * It does not have to be thrown away. `delegationWithSig` is single-use ON CONSUMPTION: a
 * signature that never landed leaves the debt token's nonce untouched and stays valid until its
 * own deadline. So it is held here, and the retry spends the same one.
 */
import type { Address, Hex } from 'viem'

/**
 * How much validity a held signature must still have to be worth reusing.
 *
 * The deadline is checked ON CHAIN at inclusion, not when we pick the signature up — and between
 * those two moments sits a re-quote, a simulation and a block. Reusing one with seconds left
 * spends gas to revert inside `delegationWithSig`, which is the same flakiness this whole change
 * is removing. Sixty seconds covers that window with room to spare.
 */
export const MIN_DELEGATION_REMAINING_S = 60n

/**
 * How far the signed borrow may sit from the one this form would solve for and still be adopted.
 *
 * A signature commits to an exact borrow (see {@link DelegationNeed.value}), so reusing one means
 * PINNING the position to it. Over a signature's lifetime the oracle moves, and with it the borrow
 * a given supply implies — adopting a signature from far enough away would open a position the
 * user did not size. One percent is close enough that the pinned figure is the one on screen, and
 * anything wider re-prompts rather than quietly resizing.
 */
export const ADOPTION_BAND_BPS = 100n

const STORAGE_PREFIX = 'defi-route.delegation.v1'

/** Just the three methods used here, so a test can pass a plain object. */
export interface DelegationStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface HeldDelegation {
  chainId: number
  owner: Address
  /** The reserve's UNDERLYING debt asset — known before any read, so it keys the entry. */
  debtAsset: Address
  /** The variable-debt token the signature is actually against. Resolved late, verified on use. */
  debtToken: Address
  /** The contract the borrowing power is delegated to. */
  delegatee: Address
  nonce: bigint
  /**
   * The borrow this authorises, EXACTLY.
   *
   * Not a ceiling: `openWith*Margin` passes its own `borrowAmount` argument as the value to
   * `delegationWithSig` (AaveV3Strategies.sol:287,343), so a signature over any other figure
   * simply fails to recover the signer. This is why reuse pins the borrow rather than tolerating
   * drift the way the close flow's headroomed permit does.
   */
  value: bigint
  deadline: bigint
  signature: Hex
  /**
   * The slippage tolerance in force when this signature was taken.
   *
   * Carried so the adoption band can be judged against the seed AT THAT TOLERANCE rather than at
   * whatever the form currently shows. `seedBorrow` divides by `1 − slippage`, so widening 0.1%
   * to 2% moves the seed ~1.9% — past the band, dropping a pin the user never asked to drop. The
   * band exists to catch the ORACLE drifting away from the signed size, not the user deliberately
   * re-pricing the same one.
   *
   * Optional: entries written before this field existed are still perfectly good signatures, and
   * fall back to the current tolerance.
   */
  slippageBps?: bigint
}

export interface DelegationNeed {
  chainId: number
  owner: Address
  debtAsset: Address
  debtToken: Address
  delegatee: Address
  nonce: bigint
  value: bigint
  nowSeconds: bigint
}

/**
 * Which requirement a held signature fails, or null if it satisfies all of them.
 *
 * Shaped after `closePlan.ts`'s `reuseBlocker`, and for the same reason: "it asked me to sign
 * again" is unfalsifiable unless something can name which predicate failed. The nonce comparison
 * is the one that proves the signature was never spent — consuming a delegation advances the debt
 * token's nonce, so a match means the grant is still live on chain.
 */
export function delegationBlocker(
  held: HeldDelegation | null,
  need: DelegationNeed,
): string | null {
  if (held === null) return 'nothing held'
  if (held.chainId !== need.chainId) return `chain ${held.chainId} → ${need.chainId}`
  if (!sameAddress(held.owner, need.owner)) return 'owner changed'
  if (!sameAddress(held.debtAsset, need.debtAsset)) return 'debt asset changed'
  if (!sameAddress(held.debtToken, need.debtToken)) return 'debt token changed'
  if (!sameAddress(held.delegatee, need.delegatee)) return 'delegatee changed'
  if (held.nonce !== need.nonce) return `nonce ${held.nonce} → ${need.nonce} (already spent)`
  // Equality, not coverage: the contract borrows the signed value itself.
  if (held.value !== need.value) return `borrow ${held.value} → ${need.value}`
  const remaining = held.deadline - need.nowSeconds
  if (remaining <= MIN_DELEGATION_REMAINING_S) {
    return `only ${remaining}s validity left, needs more than ${MIN_DELEGATION_REMAINING_S}s`
  }
  return null
}

export function canReuseDelegation(held: HeldDelegation | null, need: DelegationNeed): boolean {
  return delegationBlocker(held, need) === null
}

/**
 * Whether a held signature is still worth pinning the position to.
 *
 * `solved` is the seeded borrow — the same figure `solveBorrow` starts from — rather than a
 * solved one, because deciding whether to pin has to happen BEFORE the solve it would skip.
 */
export function withinAdoptionBand(signed: bigint, solved: bigint): boolean {
  if (signed <= 0n || solved <= 0n) return false
  const gap = signed > solved ? signed - solved : solved - signed
  return (gap * 10000n) / solved <= ADOPTION_BAND_BPS
}

/** Whether a signature has enough life left to be worth carrying into another attempt. */
export function isDelegationLive(held: HeldDelegation, nowSeconds: bigint): boolean {
  return held.deadline - nowSeconds > MIN_DELEGATION_REMAINING_S
}

export function delegationKey(p: { chainId: number; owner: Address; debtAsset: Address }): string {
  return `${STORAGE_PREFIX}:${p.chainId}:${p.owner.toLowerCase()}:${p.debtAsset.toLowerCase()}`
}

/**
 * `localStorage`, or null where there isn't one.
 *
 * Access itself can throw — Safari in private mode, and any embedding that blocks storage — so
 * this is the only place that touches the global, and every caller treats null as "nothing held".
 */
export function browserStorage(): DelegationStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

type Serialized = Record<keyof HeldDelegation, string | number>

export function loadDelegation(
  storage: DelegationStorage | null,
  key: string,
): HeldDelegation | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<Serialized>
    if (
      typeof p.chainId !== 'number' || typeof p.owner !== 'string' ||
      typeof p.debtAsset !== 'string' || typeof p.debtToken !== 'string' ||
      typeof p.delegatee !== 'string' || typeof p.nonce !== 'string' ||
      typeof p.value !== 'string' || typeof p.deadline !== 'string' ||
      typeof p.signature !== 'string'
    ) return null
    return {
      chainId: p.chainId,
      owner: p.owner as Address,
      debtAsset: p.debtAsset as Address,
      debtToken: p.debtToken as Address,
      delegatee: p.delegatee as Address,
      nonce: BigInt(p.nonce),
      value: BigInt(p.value),
      deadline: BigInt(p.deadline),
      signature: p.signature as Hex,
      // Absent on entries written before it was recorded; `undefined` reads as "not known",
      // which every caller already treats as "use the current tolerance".
      ...(typeof p.slippageBps === 'string' ? { slippageBps: BigInt(p.slippageBps) } : {}),
    }
  } catch {
    // Corrupt entry, a bigint that will not parse, or storage refusing to be read. Either way
    // there is nothing usable here, and a signature is never worth failing the flow over.
    return null
  }
}

export function saveDelegation(storage: DelegationStorage | null, held: HeldDelegation): void {
  if (!storage) return
  try {
    storage.setItem(
      delegationKey(held),
      JSON.stringify({
        ...held,
        nonce: held.nonce.toString(),
        value: held.value.toString(),
        deadline: held.deadline.toString(),
        ...(held.slippageBps === undefined ? {} : { slippageBps: held.slippageBps.toString() }),
      }),
    )
  } catch {
    // A full or blocked quota costs a wallet prompt on the next retry, nothing more.
  }
}

export function clearDelegation(storage: DelegationStorage | null, key: string): void {
  if (!storage) return
  try {
    storage.removeItem(key)
  } catch {
    // Same as above: unable to forget it is not a reason to fail anything.
  }
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}
