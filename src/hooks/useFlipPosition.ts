import { useCallback, useRef, useState } from 'react'
import { useChainId, useConnection, usePublicClient, useWalletClient } from 'wagmi'
import { type HeldSignature } from '../lib/closePlan'
import { FlipError, type FlipInput, type FlipPreview, type FlipStep } from './flip/types'
import { readPosition as readPositionStep } from './flip/readPosition'
import { previewFlip } from './flip/preview'
import { submitFlip } from './flip/submit'

/** How long to wait for a submitted flip to be mined before giving up on it (ms). */
export const RECEIPT_TIMEOUT_MS = 90_000

// Re-exported so consumers keep importing the flow's vocabulary from the hook itself.
export { FlipError }
export type { FlipInput, FlipPreview, FlipStep }


/*//////////////////////////////////////////////////////////////
                              HOOK
//////////////////////////////////////////////////////////////*/

export function useFlipPosition() {
  const { address } = useConnection()
  const chainId = useChainId()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()

  const [logs, setLogs] = useState<string[]>([])
  const [step, setStep] = useState<FlipStep>('idle')
  const [execError, setExecError] = useState<string | null>(null)
  const log = useCallback((m: string) => setLogs((prev) => [...prev, m]), [])

  /**
   * The aToken permit pair, signed but not yet spent. An EIP-2612 signature is single-use only
   * ON CONSUMPTION, so one that was never broadcast stays valid until its deadline and a second
   * press reuses it rather than re-prompting. The delegation is deliberately NOT held: it commits
   * to an exact borrow amount that changes with every re-quote.
   */
  const signatures = useRef<HeldSignature | null>(null)
  const clearSignatures = useCallback(() => {
    signatures.current = null
  }, [])

  /*────────────────────────── reads ──────────────────────────*/
  const readPosition = useCallback(
    (input: FlipInput) => readPositionStep(input, { address, chainId, publicClient }),
    [address, chainId, publicClient],
  )


  /*────────────────────────── sizing ──────────────────────────*/
  const preview = useCallback(
    (input: FlipInput) => previewFlip(input, { chainId, publicClient, readPosition, log }),
    [chainId, log, publicClient, readPosition],
  )


  /*────────────────────────── execution ──────────────────────────*/
  const flip = useCallback(
    (input: FlipInput) =>
      submitFlip(input, {
        address, chainId, publicClient, walletClient, signatures,
        preview, log, setStep, setExecError,
      }),
    [address, chainId, log, preview, publicClient, walletClient],
  )

  return { preview, flip, step, logs, execError, clearSignatures }
}
