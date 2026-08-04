import { BaseError, ContractFunctionRevertedError } from 'viem'

/**
 * Pull the most specific human-readable message out of an unknown thrown value.
 *
 * viem nests its errors: a failed write surfaces as a `BaseError` wrapping the actual
 * `ContractFunctionRevertedError` several levels down, so reading `.message` off the
 * top-level error yields the generic wrapper text rather than the revert reason. `walk`
 * finds the specific cause. Everything is guarded with `instanceof` so this accepts a
 * genuinely unknown value — the type a `catch` binding actually has.
 */
export function extractRevertMessage(err: unknown, fallback = 'Transaction failed'): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError)
    if (revert instanceof ContractFunctionRevertedError) {
      return revert.reason || revert.shortMessage || revert.message || fallback
    }
    return err.shortMessage || err.message || fallback
  }
  if (err instanceof Error) return err.message || fallback
  return String(err ?? '') || fallback
}

/**
 * `extractRevertMessage` plus viem's `details` field, which usually carries the node's
 * raw "execution reverted: ..." text. Appended only when it adds something new.
 */
export function extractDetailedError(err: unknown, fallback = 'Transaction failed'): string {
  const message = extractRevertMessage(err, fallback)
  if (err instanceof BaseError && err.details && !message.includes(err.details)) {
    return `${message}: ${err.details}`
  }
  return message
}
