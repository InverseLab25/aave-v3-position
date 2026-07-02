import { useState } from 'react'
import { useAccount, useConnect, useDisconnect } from 'wagmi'

export function WalletConnect() {
  const { address, isConnected } = useAccount()
  const { connectors, connect } = useConnect()
  const { disconnect } = useDisconnect()
  const [showModal, setShowModal] = useState(false)

  if (isConnected) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: '15px',
        padding: '8px 16px',
        border: '1px solid var(--border-color)',
        borderRadius: '8px',
        background: 'var(--bg-color)'
      }}>
        <div style={{ fontSize: '14px' }}>
          <strong>Connected:</strong> {address?.slice(0, 6)}...{address?.slice(-4)}
        </div>
        <button onClick={() => disconnect()} className="disconnect-btn">Disconnect</button>
      </div>
    )
  }

  return (
    <>
      <button className="connect-btn" onClick={() => setShowModal(true)}>
        Connect Wallet
      </button>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h3>Select a Wallet</h3>
            <div className="connect-buttons" style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '15px' }}>
              {connectors.map((connector) => (
                <button
                  key={connector.uid}
                  onClick={() => {
                    connect({ connector })
                    setShowModal(false)
                  }}
                  className="connect-btn"
                >
                  {connector.name}
                </button>
              ))}
            </div>
            <button className="btn-secondary" style={{ marginTop: '15px', width: '100%' }} onClick={() => setShowModal(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </>
  )
}
