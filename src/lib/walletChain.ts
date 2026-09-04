import { getChainConfig } from '../config/chains'

/** Enough of a viem wallet client to ask it what chain it is on. Structural, so tests need none. */
export interface ChainAware {
  getChainId: () => Promise<number>
}

const name = (id: number) => getChainConfig(id)?.name ?? `chain ${id}`

/**
 * Refuse to send when the wallet has moved to a different network than the transaction was
 * prepared for.
 *
 * Asked of the WALLET, not read off React state. `useChainId` follows the connection and the
 * flows re-quote when it changes, but a switch made in the wallet mid-confirm leaves a window:
 * the user presses Confirm on a preview built for one chain while the wallet has already moved to
 * another. What goes out then is one chain's calldata addressed to another chain's contract —
 * where that address is either nothing at all or, worse, somebody else's deployment.
 *
 * viem checks this itself when handed a `chain`, and wagmi when handed a `chainId`. This exists
 * because the close was passing `chain: null`, which turns that check OFF, and because an error
 * naming both networks is a great deal more use than `ChainMismatchError`.
 */
export async function assertWalletChain(wallet: ChainAware, expected: number): Promise<void> {
  const actual = await wallet.getChainId()
  if (actual === expected) return
  throw new Error(
    `Your wallet is on ${name(actual)}, but this transaction was prepared for ${name(expected)}. ` +
      `Switch networks and try again — nothing was submitted.`,
  )
}
