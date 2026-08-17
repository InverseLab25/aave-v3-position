import { useState, lazy, Suspense } from 'react'
import type { SuppliedAsset } from './hooks/useAavePositions'
import { useChainId } from 'wagmi'
import { WalletConnect } from './components/WalletConnect'
import { AavePosition } from './components/AavePosition'
// Lazy: the DEX tab (and its swap adapters/executor) loads only when opened,
// and no longer runs its own position fetch in the background on the Aave tab.
const DexDiscovery = lazy(() =>
  import('./components/DexDiscovery').then((m) => ({ default: m.DexDiscovery })),
)
import { getChainConfig } from './config/chains'
import { useViewMode } from './hooks/useViewMode'
import { useNativePrice } from './hooks/useNativePrice'
import { useAavePositions } from './hooks/useAavePositions'

function App() {
  const { viewAddress, viewChainId } = useViewMode()
  const connectedChainId = useChainId()
  const chainId = viewChainId ?? connectedChainId
  // Pinned to the chain being VIEWED, not the connected one, and re-quoted whenever that changes.
  // Null on a chain with no quote route, and the wrapped-native fallback below takes over.
  const apiNativePrice = useNativePrice(chainId)
  const chainConfig = getChainConfig(chainId)
  const { suppliedAssets } = useAavePositions({ viewAddress, viewChainId })

  const nativeWrappedSymbol = chainConfig?.defaultTokens?.[0]?.symbol?.toUpperCase() || 'WETH'
  // The wrapped token is the native one prefixed with W on every chain here — WETH, WBNB, WPOL,
  // WAVAX — so the label follows the chain instead of claiming ETH everywhere.
  const nativeSymbol = nativeWrappedSymbol.replace(/^W/, '')
  const wrappedNativeAsset = suppliedAssets.find((a: SuppliedAsset) => a.symbol.toUpperCase() === nativeWrappedSymbol)
  const nativePrice = apiNativePrice !== null ? apiNativePrice : (wrappedNativeAsset ? Number(wrappedNativeAsset.priceInUsd) : 0)

  const isViewMode = !!viewAddress
  const [selectedTab, setSelectedTab] = useState<'aave' | 'dex'>('aave')
  // DEX Discovery is for the connected wallet only, so force the Aave tab while
  // viewing another address — derived, not synced via an effect.
  const activeTab = isViewMode ? 'aave' : selectedTab

  const chainName = chainConfig?.name ?? `Chain ${chainId}`
  const isTestnet = chainId === 11155111 || chainId === 84532

  return (
    <div className="container">
      <header className="header">
        <h1 className="header-logo">DeFi Dashboard</h1>
        <nav className="header-tabs">
          <button
            onClick={() => setSelectedTab('aave')}
            style={{
              background: activeTab === 'aave' ? '#111' : 'transparent',
              color: activeTab === 'aave' ? '#fff' : 'var(--text-secondary)',
              border: 'none',
              fontWeight: activeTab === 'aave' ? 'bold' : 'normal',
            }}
          >
            Aave <br className="show-on-mobile" />Portfolio
          </button>
          {!isViewMode && (
            <button
              onClick={() => setSelectedTab('dex')}
              style={{
                background: activeTab === 'dex' ? '#111' : 'transparent',
                color: activeTab === 'dex' ? '#fff' : 'var(--text-secondary)',
                border: 'none',
                fontWeight: activeTab === 'dex' ? 'bold' : 'normal',
              }}
            >
              DEX <br className="show-on-mobile" />Discovery
            </button>
          )}
        </nav>
        <div className="header-network">
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
            border: `1px solid ${isTestnet ? '#fbbf24' : '#6ee7b7'}`,
            whiteSpace: 'nowrap'
          }}>
            <div style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: isTestnet ? '#f59e0b' : '#10b981'
            }}></div>
            {chainName}
          </div>
          {nativePrice !== null && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              padding: '4px 12px',
              borderRadius: '20px',
              fontSize: '12px',
              fontWeight: 'bold',
              backgroundColor: '#f3f4f6',
              color: '#374151',
              border: '1px solid #d1d5db',
              whiteSpace: 'nowrap'
            }}>
              {/* Two places reads $0.08 for POL, which is most of its value gone. */}
              {nativeSymbol}: ${nativePrice < 1 ? nativePrice.toFixed(4) : nativePrice.toFixed(2)}
            </div>
          )}
        </div>
        {!isViewMode && (
          <div className="header-wallet">
            <WalletConnect />
          </div>
        )}
      </header>
      <main>
        <div style={{ display: activeTab === 'aave' ? 'block' : 'none' }}>
          <AavePosition viewAddress={viewAddress} viewChainId={viewChainId} apiNativePrice={apiNativePrice} />
        </div>
        {!isViewMode && activeTab === 'dex' && (
          <Suspense fallback={<div style={{ padding: '20px' }}>Loading DEX Discovery…</div>}>
            <DexDiscovery />
          </Suspense>
        )}
      </main>
    </div>
  )
}

export default App
