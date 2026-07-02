import { useState, useEffect } from 'react'
import { useChainId } from 'wagmi'
import { WalletConnect } from './components/WalletConnect'
import { AavePosition } from './components/AavePosition'
import { DexDiscovery } from './components/DexDiscovery'
import { getChainConfig } from './config/chains'
import { useViewMode } from './hooks/useViewMode'
import { useEthPrice } from './hooks/useEthPrice'
import { useAavePositions } from './hooks/useAavePositions'

function App() {
  const { viewAddress, viewChainId } = useViewMode()
  const apiEthPrice = useEthPrice()
  const { suppliedAssets } = useAavePositions({ viewAddress, viewChainId })
  
  const wethAsset = suppliedAssets.find((a: any) => a.symbol === 'WETH')
  const ethPrice = wethAsset ? Number(wethAsset.priceInUsd) : apiEthPrice

  const isViewMode = !!viewAddress
  const [activeTab, setActiveTab] = useState<'aave' | 'dex'>('aave')
  // Force Aave tab while in view mode — DEX Discovery is for the connected wallet only.
  useEffect(() => {
    if (isViewMode) setActiveTab('aave')
  }, [isViewMode])
  const connectedChainId = useChainId()
  // In view mode, display the chain from the URL rather than the wallet's chain.
  const chainId = viewChainId ?? connectedChainId
  const chainConfig = getChainConfig(chainId)

  const chainName = chainConfig?.name ?? `Chain ${chainId}`
  const isTestnet = chainId === 11155111

  return (
    <div className="container">
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap' }}>
          <h1>DeFi Dashboard</h1>
          <nav style={{ display: 'flex', gap: '10px' }}>
            <button 
              onClick={() => setActiveTab('aave')}
              style={{
                background: activeTab === 'aave' ? '#111' : 'transparent',
                color: activeTab === 'aave' ? '#fff' : 'var(--text-secondary)',
                border: 'none',
                fontWeight: activeTab === 'aave' ? 'bold' : 'normal'
              }}
            >
              Aave Portfolio
            </button>
            {!isViewMode && (
              <button
                onClick={() => setActiveTab('dex')}
                style={{
                  background: activeTab === 'dex' ? '#111' : 'transparent',
                  color: activeTab === 'dex' ? '#fff' : 'var(--text-secondary)',
                  border: 'none',
                  fontWeight: activeTab === 'dex' ? 'bold' : 'normal'
                }}
              >
                DEX Discovery
              </button>
            )}
          </nav>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '6px', 
            padding: '4px 12px', 
            borderRadius: '20px', 
            fontSize: '12px', 
            fontWeight: 'bold',
            backgroundColor: isTestnet ? '#fef3c7' : '#ecfdf5',
            color: isTestnet ? '#92400e' : '#065f46',
            border: `1px solid ${isTestnet ? '#fbbf24' : '#6ee7b7'}`
          }}>
            <div style={{ 
              width: '8px', 
              height: '8px', 
              borderRadius: '50%', 
              backgroundColor: isTestnet ? '#f59e0b' : '#10b981' 
            }}></div>
            {chainName}
          </div>
          {ethPrice !== null && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              padding: '4px 12px',
              borderRadius: '20px',
              fontSize: '12px',
              fontWeight: 'bold',
              backgroundColor: '#f3f4f6',
              color: '#374151',
              border: '1px solid #d1d5db'
            }}>
              ETH: ${ethPrice.toFixed(2)}
            </div>
          )}
          {!isViewMode && <WalletConnect />}
        </div>
      </header>
      <main>
        <div style={{ display: activeTab === 'aave' ? 'block' : 'none' }}>
          <AavePosition viewAddress={viewAddress} viewChainId={viewChainId} />
        </div>
        {!isViewMode && (
          <div style={{ display: activeTab === 'dex' ? 'block' : 'none' }}>
            <DexDiscovery />
          </div>
        )}
      </main>
    </div>
  )
}

export default App
