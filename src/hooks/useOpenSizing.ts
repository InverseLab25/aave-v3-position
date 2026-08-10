import { useMemo } from 'react'
import { parseUnits } from 'viem'
import type { MarginLocation } from '../lib/strategies-sdk/sizing'
import type { OpenSizing } from './useStrategiesOpen'

interface UseOpenSizingInput {
  marginIn: MarginLocation
  marginStr: string
  marginDecimals: number
  borrowStr: string
  borrowDecimals: number
  flashStr: string
  flashDecimals: number
  leverageBps: bigint
  manualEnabled: boolean
}

/** Parses a user-typed decimal, or null when it is not yet a usable amount. */
function parse(value: string, decimals: number): bigint | null {
  try {
    const parsed = parseUnits(value || '0', decimals)
    // viem parses "-5" into a negative bigint rather than throwing. A negative amount clears
    // every downstream guard — it is trivially under the wallet balance, it can pass the LTV
    // projection against existing collateral, and `allowance < negative` is false so even the
    // approve step waves it through — and only dies at `encodeFunctionData` with
    // IntegerOutOfRange, surfaced as an opaque exec error. Reject it at the boundary instead.
    return parsed < 0n ? null : parsed
  } catch {
    return null
  }
}

/**
 * Turns the form's strings into the union `useStrategiesOpen` consumes.
 *
 * Returns `null` rather than a partial sizing whenever an active field does not parse, so the
 * caller passes `null` to the hook and nothing is quoted against a half-typed amount. Ratchet
 * is always manual: with no margin there is no base for leverage to multiply.
 */
export function useOpenSizing(p: UseOpenSizingInput): { sizing: OpenSizing | null; manual: boolean } {
  const manual = p.manualEnabled || p.marginIn === 'none'

  return useMemo(() => {
    const marginAmount = p.marginIn === 'none' ? 0n : parse(p.marginStr, p.marginDecimals)
    if (marginAmount === null) return { sizing: null, manual }

    if (!manual) {
      if (marginAmount <= 0n) return { sizing: null, manual }
      return { sizing: { kind: 'derived', marginAmount, leverageBps: p.leverageBps }, manual }
    }

    const borrowAmount = parse(p.borrowStr, p.borrowDecimals)
    const flashAmount = parse(p.flashStr, p.flashDecimals)
    if (borrowAmount === null || flashAmount === null) return { sizing: null, manual }

    return { sizing: { kind: 'manual', marginAmount, borrowAmount, flashAmount }, manual }
  }, [
    manual, p.marginIn, p.marginStr, p.marginDecimals, p.borrowStr, p.borrowDecimals,
    p.flashStr, p.flashDecimals, p.leverageBps,
  ])
}
