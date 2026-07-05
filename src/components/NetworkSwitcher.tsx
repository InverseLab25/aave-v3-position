import { useAccount, useChainId, useSwitchChain } from 'wagmi'
import { getChainConfig } from '../config/chains'

/**
 * Dropdown to switch the connected wallet between the configured networks.
 * Uses wagmi's useSwitchChain, which asks the wallet to switch (or add) the
 * chain. Renders nothing until a wallet is connected. `chains` are the
 * wagmi-configured networks, so every option is guaranteed switchable.
 */
export function NetworkSwitcher() {
  const { isConnected } = useAccount()
  const chainId = useChainId()
  const { chains, switchChain, isPending } = useSwitchChain()

  if (!isConnected) return null

  return (
    <select
      aria-label="Switch network"
      value={chainId}
      disabled={isPending}
      onChange={(e) => switchChain({ chainId: Number(e.target.value) })}
      style={{
        padding: '4px 10px',
        borderRadius: '20px',
        fontSize: '12px',
        fontWeight: 'bold',
        border: '1px solid #d1d5db',
        backgroundColor: '#fff',
        color: '#374151',
        cursor: isPending ? 'wait' : 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {chains.map((c) => (
        <option key={c.id} value={c.id}>
          {getChainConfig(c.id)?.name ?? c.name}
        </option>
      ))}
    </select>
  )
}
