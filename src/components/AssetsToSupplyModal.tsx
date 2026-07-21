import { useState } from 'react'
import { useAccount, useBalance, useReadContracts, useReadContract, useWriteContract, useWaitForTransactionReceipt, useConfig } from 'wagmi'
import { formatUnits, parseUnits, maxUint256, erc20Abi } from 'viem'
import { getChainConfig } from '../config/chains'
import { useAdjustedGas } from '../hooks/useAdjustedGas'
import { healthFactor, evaluateHf } from '../utils/health'
import { simulateAndWrite, approveAbi } from '../utils/contract'
import { GasInfoCard } from './GasInfoCard'
import { ExplorerLink } from './ExplorerLink'
import wethGatewayAbi from '../config/wethGatewayAbi.json'
import aavePoolAbi from '../config/aavev3Abi.json'
import { T, modalStyle, modalHeaderStyle, modalTitleStyle, closeButtonStyle, labelStyle, inputStyle, alertStyle, primaryBtnStyle } from '../styles/theme'

interface AssetsToSupplyModalProps {
  chainId: number
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  availableReserves: any[]
  ethPriceUsd?: number
  collateralUsd?: number
  debtUsd?: number
  liquidationThreshold?: number
  onClose: () => void
}

export function AssetsToSupplyModal({ chainId, availableReserves, ethPriceUsd = 0, collateralUsd = 0, debtUsd = 0, liquidationThreshold = 0, onClose }: AssetsToSupplyModalProps) {
  const { address } = useAccount()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [selectedAsset, setSelectedAsset] = useState<any | null>(null)
  const [amountStr, setAmountStr] = useState<string>('')
  const [step, setStep] = useState<number>(0)
  const [statusMsg, setStatusMsg] = useState<string>('')
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>(undefined)

  const chainConfig = getChainConfig(chainId)
  const poolAddress = chainConfig?.aave?.poolAddress as `0x${string}`

  const { writeContractAsync } = useWriteContract()
  const config = useConfig()
  const { isLoading: isWaitingTx } = useWaitForTransactionReceipt({ hash: txHash })

  const { maxFee, maxPriority, estimatedFeeUsd } = useAdjustedGas(250000n /* Aave supply */, ethPriceUsd, parseFloat(amountStr) > 0)

  const { data: ethBalance } = useBalance({ address })

  const targetSymbols = chainConfig?.defaultTokens?.map(t => t.symbol.toUpperCase()) || ['WETH', 'USDC', 'USDT']
  const filteredReserves = availableReserves.filter(r => targetSymbols.includes(r.symbol.toUpperCase()))
  const nativeWrappedSymbol = chainConfig?.defaultTokens?.[0]?.symbol?.toUpperCase() || 'WETH'
  const wethReserve = filteredReserves.find(r => r.symbol.toUpperCase() === nativeWrappedSymbol)
  const supplyOptions = [...filteredReserves]
  if (wethReserve) supplyOptions.unshift({ ...wethReserve, symbol: 'ETH', underlyingAsset: 'native' })

  // Native ETH uses useBalance above; only ERC-20s go through the multicall
  // (a balanceOf on the zero address always fails and wastes a call slot).
  const tokenOptions = supplyOptions.filter(o => o.underlyingAsset !== 'native')
  const { data: tokenBalances } = useReadContracts({
    contracts: tokenOptions.map(opt => ({
      address: opt.underlyingAsset as `0x${string}`,
      abi: erc20Abi, functionName: 'balanceOf' as const,
      args: address ? [address] : undefined,
    })),
    query: { enabled: !!address },
  })

  const balanceByAddress: Record<string, bigint> = {}
  tokenOptions.forEach((opt, i) => {
    balanceByAddress[opt.underlyingAsset.toLowerCase()] = (tokenBalances?.[i]?.result as bigint | undefined) ?? 0n
  })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getRawBalance = (opt: any): bigint => {
    if (opt.symbol === 'ETH') return ethBalance?.value ?? 0n
    return balanceByAddress[opt.underlyingAsset.toLowerCase()] ?? 0n
  }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getWalletBalance = (opt: any) => {
    const raw = getRawBalance(opt)
    const decimals = opt.symbol === 'ETH' ? (ethBalance?.decimals ?? 18) : opt.decimals
    return Number(formatUnits(raw, decimals))
  }

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: selectedAsset?.underlyingAsset !== 'native' ? selectedAsset?.underlyingAsset : undefined,
    abi: erc20Abi, functionName: 'allowance',
    args: (address && selectedAsset && selectedAsset.underlyingAsset !== 'native' && poolAddress) ? [address, poolAddress] : undefined,
    query: { enabled: !!address && !!selectedAsset && selectedAsset.underlyingAsset !== 'native' && !!poolAddress },
  })

  const executeSupply = async () => {
    if (!address || !amountStr || !selectedAsset || !poolAddress) return
    try {
      if (selectedAsset.symbol === 'ETH') {
        const gatewayAddress = chainConfig?.aave?.wethGateway as `0x${string}` | undefined
        if (!gatewayAddress) { alert('Native ETH supplying is not supported on this network.'); return }
        setStep(3); setStatusMsg('Simulating depositETH…')
        const hash = await simulateAndWrite(config, writeContractAsync, {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
          address: gatewayAddress, abi: wethGatewayAbi as any,
          functionName: 'depositETH', args: [poolAddress, address, 0],
          value: parseUnits(amountStr, selectedAsset.decimals) as bigint,
        })
        setTxHash(hash); setStep(4); setStatusMsg('Supply transaction sent!')
        return
      }
      setStep(1)
      const amount = parseUnits(amountStr, selectedAsset.decimals)
      const currentAllowance = (allowance as bigint) ?? 0n
      if (currentAllowance < amount) {
        setStatusMsg('Simulating approval…')
        const hash = await simulateAndWrite(config, writeContractAsync, {
          address: selectedAsset.underlyingAsset as `0x${string}`, abi: approveAbi,
          functionName: 'approve', args: [poolAddress, maxUint256],
        })
        setTxHash(hash); setStep(2); setStatusMsg('Approval sent. Click Supply again to continue.')
        await refetchAllowance()
        return
      }
      setStep(3); setStatusMsg('Simulating supply…')
      const hash = await simulateAndWrite(config, writeContractAsync, {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        address: poolAddress, abi: aavePoolAbi as any,
        functionName: 'supply', args: [selectedAsset.underlyingAsset as `0x${string}`, amount, address, 0],
      })
      setTxHash(hash); setStep(4); setStatusMsg('Supply transaction sent!')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      const reason = e?.cause?.reason ?? e?.shortMessage ?? e?.message ?? 'Unknown error'
      setStatusMsg(`Error: ${reason}`); setStep(0)
    }
  }

  const isProcessing = isWaitingTx || step === 1 || step === 3
  const isError = statusMsg.startsWith('Error')

  const selectedWalletBalance = selectedAsset ? getWalletBalance(selectedAsset) : 0
  const amountNum = parseFloat(amountStr) || 0
  const isInsufficient = selectedAsset && amountNum > selectedWalletBalance

  const supplyUsd = amountNum * (selectedAsset?.priceInUsd ? parseFloat(selectedAsset.priceInUsd) : 0)
  const currentHealthFactor = healthFactor(collateralUsd * liquidationThreshold, debtUsd)
  const newHealthFactor = selectedAsset
    ? healthFactor(collateralUsd * liquidationThreshold + supplyUsd * selectedAsset.liquidationThreshold, debtUsd)
    : '∞'
  const hfGuard = evaluateHf(amountNum > 0 ? newHealthFactor : '∞')

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-content" style={{ ...modalStyle, maxWidth: '600px' }}>
        {/* Header */}
        <div style={modalHeaderStyle}>
          <h2 style={modalTitleStyle}>{selectedAsset ? `Supply ${selectedAsset.symbol}` : 'Assets to Supply'}</h2>
          <button style={closeButtonStyle} onClick={onClose}>×</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {!selectedAsset ? (
            /* ── Asset list ─────────────────────────────────────────────── */
            <table>
              <thead>
                <tr>
                  <th style={{ paddingLeft: T.space[5] }}>Asset</th>
                  <th>Balance</th>
                  <th>APY</th>
                  <th className="align-right-desktop" style={{ paddingRight: T.space[5] }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {supplyOptions.map((opt) => {
                  const bal = getWalletBalance(opt)
                  return (
                    <tr key={opt.symbol}>
                      <td style={{ paddingLeft: T.space[5] }}>
                        <div style={{ fontWeight: 600 }}>{opt.symbol}</div>
                        {opt.symbol !== 'ETH' && (
                          <div style={{ fontSize: '10px', color: T.textMuted, fontFamily: T.font.mono, marginTop: '2px' }} title={opt.underlyingAsset}>
                            {opt.underlyingAsset.slice(0, 6)}…{opt.underlyingAsset.slice(-4)}
                          </div>
                        )}
                      </td>
                      <td style={{ fontFamily: T.font.mono }}>{bal > 0 ? bal.toFixed(4) : '0.00'}</td>
                      <td className="text-success" style={{ fontFamily: T.font.mono }}>{opt.apy?.toFixed(2) ?? '—'}%</td>
                      <td className="align-right-desktop" style={{ paddingRight: T.space[5] }}>
                        <button
                          className="btn-primary"
                          style={{ padding: '5px 14px', fontSize: T.fontSize.sm }}
                          onClick={() => { setSelectedAsset(opt); setStep(0); setStatusMsg('') }}
                        >Supply</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            /* ── Supply form ─────────────────────────────────────────────── */
            <div style={{ padding: T.space[5] }}>
              <button
                className="btn-ghost"
                style={{ marginBottom: T.space[5], fontSize: T.fontSize.sm }}
                onClick={() => { setSelectedAsset(null); setAmountStr(''); setStep(0); setStatusMsg('') }}
              >← Back to Assets</button>

              <h3 style={{ margin: `0 0 ${T.space[5]}`, fontSize: T.fontSize.lg, color: T.text }}>Supply {selectedAsset.symbol}</h3>

              <div style={{ marginBottom: T.space[4], position: 'relative' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: T.space[2] }}>
                  <label style={{ ...labelStyle, marginBottom: 0 }}>Amount</label>
                  <span style={{ fontSize: T.fontSize.sm, color: T.textMuted }}>
                    Available: <strong style={{ color: T.text, fontFamily: T.font.mono }}>{selectedWalletBalance.toFixed(4)} {selectedAsset.symbol}</strong>
                  </span>
                </div>
                <input
                  type="number" step="any" value={amountStr} onChange={e => setAmountStr(e.target.value)}
                  placeholder="0.00" style={{ ...inputStyle, paddingRight: '56px' }}
                  onFocus={e => (e.currentTarget.style.borderColor = T.borderFocus)}
                  onBlur={e => (e.currentTarget.style.borderColor = T.border)}
                />
                <button
                  onClick={() => setAmountStr(formatUnits(getRawBalance(selectedAsset), selectedAsset.symbol === 'ETH' ? (ethBalance?.decimals ?? 18) : selectedAsset.decimals))}
                  style={{ position: 'absolute', right: '10px', bottom: '10px', padding: '2px 8px', fontSize: T.fontSize.xs, fontWeight: 700, color: T.primary, background: '#eff6ff', border: `1px solid #bfdbfe`, borderRadius: T.radius.sm, cursor: 'pointer' }}
                >MAX</button>
              </div>

              <GasInfoCard
                maxFee={maxFee}
                maxPriority={maxPriority}
                estimatedFeeUsd={estimatedFeeUsd}
                currentHealthFactor={amountNum > 0 ? currentHealthFactor : undefined}
                newHealthFactor={amountNum > 0 ? newHealthFactor : undefined}
              />

              {hfGuard.message && <div style={alertStyle(hfGuard.level === 'block' ? 'danger' : 'warning')}>{hfGuard.message}</div>}
              {statusMsg && <div style={alertStyle(isError ? 'danger' : step === 4 ? 'success' : 'info')}>{statusMsg}</div>}
              {txHash && <ExplorerLink hash={txHash} chainId={chainId} />}

              <button
                style={primaryBtnStyle(!amountStr || isProcessing || isInsufficient || hfGuard.level === 'block')}
                onClick={executeSupply}
                disabled={!amountStr || isProcessing || isInsufficient || hfGuard.level === 'block'}
              >{isInsufficient ? 'Insufficient balance' : hfGuard.level === 'block' ? 'Health factor too low' : isProcessing ? 'Processing…' : 'Supply'}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
