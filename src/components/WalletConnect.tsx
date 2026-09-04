import { useState } from 'react'
import { useConnection, useConnect, useConnectors, useDisconnect } from 'wagmi'
import { usableConnectors } from '../lib/walletConnectors'
import { MODAL_WIDTH } from '../styles/theme'
import { Modal } from './Modal'
import { NetworkSwitcher } from './NetworkSwitcher'

export function WalletConnect() {
  const { address, isConnected, connector: active } = useConnection()
  const connectors = usableConnectors(useConnectors(), active)
  // `error` and `isPending` are the whole reason this is not a bare `mutate`: a wallet prompt can
  // be rejected or time out, and without them the picker closed on click and the user was left
  // looking at a Connect button with no idea why nothing happened.
  const { mutate: connect, isPending, error, reset } = useConnect()
  const { mutate: disconnect } = useDisconnect()
  const [picking, setPicking] = useState(false)

  const close = () => {
    setPicking(false)
    // Or the last failure is still on screen the next time the picker opens.
    reset()
  }

  if (isConnected) {
    return (
      <div className="wallet-container">
        <NetworkSwitcher />
        <div style={{ fontSize: '14px', whiteSpace: 'nowrap' }}>
          <strong className="hide-on-mobile">Connected: </strong>
          {address?.slice(0, 6)}...{address?.slice(-4)}
        </div>
        <button onClick={() => disconnect()} className="disconnect-btn">Disconnect</button>
      </div>
    )
  }

  return (
    <>
      <button className="connect-btn" onClick={() => setPicking(true)}>
        Connect Wallet
      </button>

      {/* The shared shell, not a hand-rolled one. It is what gives this Escape, a backdrop click
          and the header `×` — none of which this screen had while it built its own overlay, and
          all of which every other modal in the app already had. `form` width because the content
          is a short list of rows rather than a table. */}
      {picking && (
        <Modal title="Select a wallet" onClose={close} maxWidth={MODAL_WIDTH.form}>
          {error && (
            <div className="alert alert-danger" role="alert" style={{ marginBottom: 'var(--space-4)' }}>
              {error.message}
            </div>
          )}

          {connectors.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>
              No wallet detected. Install a browser wallet such as MetaMask, then reload.
            </p>
          ) : (
            <div className="wallet-options">
              {connectors.map((connector) => (
                <button
                  key={connector.uid}
                  type="button"
                  className="wallet-option"
                  disabled={isPending}
                  // Closed on SUCCESS, not on click. Closing immediately dismissed the picker
                  // while the wallet prompt was still open, so a rejected connection had nowhere
                  // left to report itself.
                  onClick={() => connect({ connector }, { onSuccess: close })}
                >
                  {connector.icon ? (
                    <img className="wallet-option-icon" src={connector.icon} alt="" width={24} height={24} />
                  ) : (
                    <span className="wallet-option-icon" aria-hidden />
                  )}
                  <span>{connector.name}</span>
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}
    </>
  )
}
