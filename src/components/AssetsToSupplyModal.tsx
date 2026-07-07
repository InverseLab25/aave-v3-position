import { useState } from 'react'
import { useAccount, useBalance, useReadContracts, useReadContract, useWriteContract, useWaitForTransactionReceipt, useConfig, useEstimateFeesPerGas } from 'wagmi'
import { formatUnits, parseUnits, maxUint256, erc20Abi, formatGwei } from 'viem'
import { getChainConfig } from '../config/chains'
import { calculateAdjustedFees } from '../utils/gas'
import { simulateAndWrite } from '../utils/contract'
import wethGatewayAbi from '../config/wethGatewayAbi.json'
import aavePoolAbi from '../config/aavev3Abi.json'
import { T, modalStyle, modalHeaderStyle, modalTitleStyle, closeButtonStyle, labelStyle, inputStyle, infoCardStyle, alertStyle, primaryBtnStyle } from '../styles/theme'

interface AssetsToSupplyModalProps {
  chainId: number
  availableReserves: any[]
  ethPriceUsd?: number
  onClose: () => void
}

export function AssetsToSupplyModal({ chainId, availableReserves, ethPriceUsd = 0, onClose }: AssetsToSupplyModalProps) {
  const { address } = useAccount()
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

  const { data: feeData } = useEstimateFeesPerGas()
  const { adjustedMaxFeePerGas: uiMaxFee, adjustedMaxPriorityFeePerGas: uiMaxPriority } =
    calculateAdjustedFees(feeData?.maxFeePerGas, feeData?.maxPriorityFeePerGas)

  const { data: ethBalance } = useBalance({ address })

  const targetSymbols = ['WETH', 'USDC', 'USDT']
  const filteredReserves = availableReserves.filter(r => targetSymbols.includes(r.symbol.toUpperCase()))
  const wethReserve = filteredReserves.find(r => r.symbol.toUpperCase() === 'WETH')
  const supplyOptions = [...filteredReserves]
  if (wethReserve) supplyOptions.unshift({ ...wethReserve, symbol: 'ETH', underlyingAsset: 'native' })

  const { data: balances } = useReadContracts({
    contracts: supplyOptions.map(opt => ({
      address: opt.underlyingAsset as `0x${string}`,
      abi: erc20Abi, functionName: 'balanceOf' as const,
      args: address ? [address] : undefined,
    })),
    query: { enabled: !!address },
  })

  const getWalletBalance = (opt: any, index: number) => {
    if (opt.symbol === 'ETH') return ethBalance ? Number(formatUnits(ethBalance.value, ethBalance.decimals)) : 0
    const bal = balances?.[index]?.result as bigint | undefined
    return bal ? Number(formatUnits(bal, opt.decimals)) : 0
  }

  const { data: allowance } = useReadContract({
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
          address: selectedAsset.underlyingAsset as `0x${string}`, abi: erc20Abi,
          functionName: 'approve', args: [poolAddress, maxUint256],
        })
        setTxHash(hash); setStep(2); setStatusMsg('Approval sent. Click Supply again to continue.')
        return
      }
      setStep(3); setStatusMsg('Simulating supply…')
      const hash = await simulateAndWrite(config, writeContractAsync, {
        address: poolAddress, abi: aavePoolAbi as any,
        functionName: 'supply', args: [selectedAsset.underlyingAsset as `0x${string}`, amount, address, 0],
      })
      setTxHash(hash); setStep(4); setStatusMsg('Supply transaction sent!')
    } catch (e: any) {
      const reason = e?.cause?.reason ?? e?.shortMessage ?? e?.message ?? 'Unknown error'
      setStatusMsg(`Error: ${reason}`); setStep(0)
    }
  }

  const isProcessing = isWaitingTx || step === 1 || step === 3
  const isError = statusMsg.startsWith('Error')

  const selectedIndex = selectedAsset ? supplyOptions.findIndex(o => o.symbol === selectedAsset.symbol) : -1
  const selectedWalletBalance = selectedAsset ? getWalletBalance(selectedAsset, selectedIndex) : 0
  const amountNum = parseFloat(amountStr) || 0
  const isInsufficient = selectedAsset && amountNum > selectedWalletBalance

  const assumedGasLimit = 250000n // Rough estimate for Aave supply
  const estimatedFeeUsd = (uiMaxFee && ethPriceUsd > 0) ? Number(formatUnits(uiMaxFee * assumedGasLimit, 18)) * ethPriceUsd : 0

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ ...modalStyle, maxWidth: '600px' }}>
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
                  <th>Wallet Balance</th>
                  <th>APY</th>
                  <th style={{ textAlign: 'right', paddingRight: T.space[5] }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {supplyOptions.map((opt, i) => {
                  const bal = getWalletBalance(opt, i)
                  return (
                    <tr key={opt.symbol}>
                      <td style={{ paddingLeft: T.space[5], fontWeight: 600 }}>{opt.symbol}</td>
                      <td style={{ fontFamily: T.font.mono }}>{bal > 0 ? bal.toFixed(4) : '0.00'}</td>
                      <td className="text-success" style={{ fontFamily: T.font.mono }}>{opt.apy?.toFixed(2) ?? '—'}%</td>
                      <td style={{ textAlign: 'right', paddingRight: T.space[5] }}>
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
                  onClick={() => setAmountStr(selectedWalletBalance.toString())}
                  style={{ position: 'absolute', right: '10px', bottom: '10px', padding: '2px 8px', fontSize: T.fontSize.xs, fontWeight: 700, color: T.primary, background: '#eff6ff', border: `1px solid #bfdbfe`, borderRadius: T.radius.sm, cursor: 'pointer' }}
                >MAX</button>
              </div>

              {uiMaxFee && uiMaxPriority && (
                <div style={infoCardStyle}>
                  <div style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between' }}>
                    <span>Estimated Gas</span>
                    {estimatedFeeUsd > 0 && <span style={{ color: T.text }}>~${estimatedFeeUsd.toFixed(2)}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: T.space[6], fontSize: T.fontSize.sm }}>
                    <span style={{ color: T.textMuted }}>Max fee: <strong style={{ color: T.text, fontFamily: T.font.mono }}>{Number(formatGwei(uiMaxFee)).toFixed(2)} Gwei</strong></span>
                    <span style={{ color: T.textMuted }}>Priority: <strong style={{ color: T.text, fontFamily: T.font.mono }}>{Number(formatGwei(uiMaxPriority)).toFixed(2)} Gwei</strong></span>
                  </div>
                </div>
              )}

              {statusMsg && <div style={alertStyle(isError ? 'danger' : step === 4 ? 'success' : 'info')}>{statusMsg}</div>}

              <button
                style={primaryBtnStyle(!amountStr || isProcessing || isInsufficient)}
                onClick={executeSupply}
                disabled={!amountStr || isProcessing || isInsufficient}
              >{isInsufficient ? 'Insufficient balance' : isProcessing ? 'Processing…' : 'Supply'}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
