import { useState } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useConfig, useEstimateFeesPerGas, useReadContract } from 'wagmi'
import { parseUnits, formatGwei, formatUnits, maxUint256 } from 'viem'
import { getChainConfig } from '../config/chains'
import { calculateAdjustedFees } from '../utils/gas'
import { simulateAndWrite } from '../utils/contract'
import wethGatewayAbi from '../config/wethGatewayAbi.json'
import { T, modalStyle, modalHeaderStyle, modalTitleStyle, closeButtonStyle, labelStyle, inputStyle, infoCardStyle, alertStyle, primaryBtnStyle } from '../styles/theme'

interface AssetsToBorrowModalProps {
  chainId: number
  availableReserves: any[]
  ethPriceUsd?: number
  availableBorrowsUsd?: number
  collateralUsd?: number
  debtUsd?: number
  liquidationThreshold?: number
  onClose: () => void
}

const AAVE_POOL_ADDRESS = '0x87870Bca3F3fD6335C3F4ce8392D6935E69e6B0'
const RATE_MODE = 2n

const AAVE_POOL_ABI = [{
  inputs: [
    { internalType: 'address', name: 'asset', type: 'address' },
    { internalType: 'uint256', name: 'amount', type: 'uint256' },
    { internalType: 'uint256', name: 'interestRateMode', type: 'uint256' },
    { internalType: 'uint16', name: 'referralCode', type: 'uint16' },
    { internalType: 'address', name: 'onBehalfOf', type: 'address' }
  ],
  name: 'borrow', outputs: [], stateMutability: 'nonpayable', type: 'function'
}] as const

const debtTokenAbi = [
  { inputs: [{ internalType: 'address', name: 'delegatee', type: 'address' }, { internalType: 'uint256', name: 'amount', type: 'uint256' }], name: 'approveDelegation', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [{ internalType: 'address', name: 'fromUser', type: 'address' }, { internalType: 'address', name: 'toUser', type: 'address' }], name: 'borrowAllowance', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' }
] as const

export function AssetsToBorrowModal({ chainId, availableReserves, ethPriceUsd = 0, availableBorrowsUsd = 0, collateralUsd = 0, debtUsd = 0, liquidationThreshold = 0, onClose }: AssetsToBorrowModalProps) {
  const { address } = useAccount()
  const [selectedAsset, setSelectedAsset] = useState<any | null>(null)
  const [amountStr, setAmountStr] = useState<string>('')
  const [step, setStep] = useState<number>(0)
  const [statusMsg, setStatusMsg] = useState<string>('')
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>(undefined)

  const chainConfig = getChainConfig(chainId)
  const poolAddress = (chainConfig?.aave?.poolAddress ?? AAVE_POOL_ADDRESS) as `0x${string}`
  const { writeContractAsync } = useWriteContract()
  const config = useConfig()
  const { isLoading: isWaitingTx } = useWaitForTransactionReceipt({ hash: txHash })

  const { data: feeData } = useEstimateFeesPerGas()
  const { adjustedMaxFeePerGas: uiMaxFee, adjustedMaxPriorityFeePerGas: uiMaxPriority } =
    calculateAdjustedFees(feeData?.maxFeePerGas, feeData?.maxPriorityFeePerGas)

  const targetSymbols = ['WETH', 'USDC', 'USDT']
  const filteredReserves = availableReserves.filter(r => targetSymbols.includes(r.symbol.toUpperCase()))
  const wethReserve = filteredReserves.find(r => r.symbol.toUpperCase() === 'WETH')
  const borrowOptions = [...filteredReserves]
  if (wethReserve) borrowOptions.unshift({ ...wethReserve, symbol: 'ETH', underlyingAsset: 'native' })

  const gatewayAddress = chainConfig?.aave?.wethGateway as `0x${string}` | undefined

  const { data: delegationAllowance, refetch: refetchDelegation } = useReadContract({
    address: selectedAsset?.symbol === 'ETH' ? selectedAsset.variableDebtTokenAddress : undefined,
    abi: debtTokenAbi, functionName: 'borrowAllowance',
    args: (address && selectedAsset && selectedAsset.symbol === 'ETH' && gatewayAddress) ? [address, gatewayAddress] : undefined,
    query: { enabled: !!address && !!selectedAsset && selectedAsset.symbol === 'ETH' && !!gatewayAddress },
  })

  const executeBorrow = async () => {
    if (!address || !amountStr || !selectedAsset) return
    try {
      const amountParsed = parseUnits(amountStr, selectedAsset.decimals)
      if (selectedAsset.symbol === 'ETH') {
        if (!gatewayAddress) { alert('Native ETH borrowing is not supported on this network.'); return }
        
        const currentDelegation = (delegationAllowance as bigint) ?? 0n
        if (currentDelegation < amountParsed) {
          setStatusMsg('Simulating delegation approval…')
          const hash = await simulateAndWrite(config, writeContractAsync, {
            address: selectedAsset.variableDebtTokenAddress as `0x${string}`, abi: debtTokenAbi,
            functionName: 'approveDelegation', args: [gatewayAddress, maxUint256],
          })
          setTxHash(hash); setStep(2); setStatusMsg('Delegation approved. Click Borrow again to continue.')
          await refetchDelegation()
          return
        }

        setStep(3); setStatusMsg('Simulating borrowETH…')
        const hash = await simulateAndWrite(config, writeContractAsync, {
          address: gatewayAddress, abi: wethGatewayAbi as any,
          functionName: 'borrowETH', args: [poolAddress, amountParsed, RATE_MODE, 0],
        })
        setTxHash(hash); setStep(4); setStatusMsg('Borrow transaction sent!')
        return
      }
      setStep(3); setStatusMsg('Simulating borrow…')
      const hash = await simulateAndWrite(config, writeContractAsync, {
        address: poolAddress, abi: AAVE_POOL_ABI,
        functionName: 'borrow', args: [selectedAsset.underlyingAsset as `0x${string}`, amountParsed, RATE_MODE, 0, address],
      })
      setTxHash(hash); setStep(4); setStatusMsg('Borrow transaction sent!')
    } catch (e: any) {
      const reason = e?.cause?.reason ?? e?.shortMessage ?? e?.message ?? 'Unknown error'
      setStatusMsg(`Error: ${reason}`); setStep(0)
    }
  }

  const isProcessing = isWaitingTx || step === 3
  const isError = statusMsg.startsWith('Error')

  const amountNum = parseFloat(amountStr) || 0
  const maxBorrowAmount = selectedAsset && selectedAsset.priceInUsd > 0 ? (availableBorrowsUsd / Number(selectedAsset.priceInUsd)) * 0.99 : 0 // 99% safety margin
  const isInsufficient = amountNum > maxBorrowAmount

  let newHealthFactor = '∞'
  const currentHealthFactor = debtUsd > 0 ? ((collateralUsd * liquidationThreshold) / debtUsd).toFixed(2) : '∞'
  if (collateralUsd > 0) {
    const borrowAmountUsd = amountNum * (Number(selectedAsset?.priceInUsd) || 0)
    const newDebtUsd = debtUsd + borrowAmountUsd
    if (newDebtUsd > 0) {
      newHealthFactor = ((collateralUsd * liquidationThreshold) / newDebtUsd).toFixed(2)
    }
  }

  const assumedGasLimit = 300000n // Rough estimate for Aave borrow
  const estimatedFeeUsd = (uiMaxFee && ethPriceUsd > 0) ? Number(formatUnits(uiMaxFee * assumedGasLimit, 18)) * ethPriceUsd : 0

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ ...modalStyle, maxWidth: '600px' }}>
        <div style={modalHeaderStyle}>
          <h2 style={modalTitleStyle}>{selectedAsset ? `Borrow ${selectedAsset.symbol}` : 'Assets to Borrow'}</h2>
          <button style={closeButtonStyle} onClick={onClose}>×</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {!selectedAsset ? (
            <table>
              <thead>
                <tr>
                  <th style={{ paddingLeft: T.space[5] }}>Asset</th>
                  <th>Borrow APY</th>
                  <th style={{ textAlign: 'right', paddingRight: T.space[5] }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {borrowOptions.map((opt) => (
                  <tr key={opt.symbol}>
                    <td style={{ paddingLeft: T.space[5], fontWeight: 600 }}>{opt.symbol}</td>
                    <td className="text-danger" style={{ fontFamily: T.font.mono }}>{opt.borrowApy?.toFixed(2) || '0.00'}%</td>
                    <td style={{ textAlign: 'right', paddingRight: T.space[5] }}>
                      <button
                        className="btn-primary"
                        style={{ padding: '5px 14px', fontSize: T.fontSize.sm }}
                        onClick={() => { setSelectedAsset(opt); setStep(0); setStatusMsg('') }}
                      >Borrow</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ padding: T.space[5] }}>
              <button
                className="btn-ghost"
                style={{ marginBottom: T.space[5], fontSize: T.fontSize.sm }}
                onClick={() => { setSelectedAsset(null); setAmountStr(''); setStep(0); setStatusMsg('') }}
              >← Back to Assets</button>

              <h3 style={{ margin: `0 0 ${T.space[5]}`, fontSize: T.fontSize.lg, color: T.text }}>
                Borrow {selectedAsset.symbol}
                <span style={{ fontSize: T.fontSize.sm, color: T.textMuted, fontWeight: 400, marginLeft: T.space[2] }}>
                  Variable APY {selectedAsset.borrowApy?.toFixed(2) ?? '—'}%
                </span>
              </h3>

              <div style={{ marginBottom: T.space[4], position: 'relative' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: T.space[2] }}>
                  <label style={{ ...labelStyle, marginBottom: 0 }}>Amount</label>
                  <span style={{ fontSize: T.fontSize.sm, color: T.textMuted }}>
                    Available: <strong style={{ color: T.text, fontFamily: T.font.mono }}>{maxBorrowAmount.toFixed(4)} {selectedAsset.symbol}</strong>
                  </span>
                </div>
                <input
                  type="number" step="any" value={amountStr} onChange={e => setAmountStr(e.target.value)}
                  placeholder="0.00" style={{ ...inputStyle, paddingRight: '56px' }}
                  onFocus={e => (e.currentTarget.style.borderColor = T.borderFocus)}
                  onBlur={e => (e.currentTarget.style.borderColor = T.border)}
                />
                <button
                  onClick={() => setAmountStr(maxBorrowAmount.toString())}
                  style={{ position: 'absolute', right: '10px', bottom: '10px', padding: '2px 8px', fontSize: T.fontSize.xs, fontWeight: 700, color: T.primary, background: '#eff6ff', border: `1px solid #bfdbfe`, borderRadius: T.radius.sm, cursor: 'pointer' }}
                >MAX</button>
              </div>

              {((uiMaxFee && uiMaxPriority) || amountNum > 0) && (
                <div style={infoCardStyle}>
                  {amountNum > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: T.space[4], fontSize: T.fontSize.sm, fontWeight: 500, color: T.text }}>
                      <span>Health Factor</span>
                      <span style={{ color: Number(newHealthFactor) < 1.1 ? T.danger : Number(newHealthFactor) < 1.5 ? T.warning : T.success, fontFamily: T.font.mono, fontWeight: 700, fontSize: T.fontSize.base }}>
                        {currentHealthFactor} → {newHealthFactor}
                      </span>
                    </div>
                  )}
                  {uiMaxFee && uiMaxPriority && (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: T.fontSize.sm, fontWeight: 500, color: T.text, marginBottom: T.space[2] }}>
                        <span>Estimated Gas</span>
                        {estimatedFeeUsd > 0 && <span style={{ color: T.text, fontWeight: 700, fontSize: T.fontSize.base }}>~${estimatedFeeUsd.toFixed(2)}</span>}
                      </div>
                      <div style={{ display: 'flex', gap: T.space[6], fontSize: T.fontSize.xs }}>
                        <span style={{ color: T.textMuted }}>Max fee: <strong style={{ color: T.text, fontFamily: T.font.mono }}>{Number(formatGwei(uiMaxFee)).toFixed(2)} Gwei</strong></span>
                        <span style={{ color: T.textMuted }}>Priority: <strong style={{ color: T.text, fontFamily: T.font.mono }}>{Number(formatGwei(uiMaxPriority)).toFixed(2)} Gwei</strong></span>
                      </div>
                    </>
                  )}
                </div>
              )}

              {statusMsg && <div style={alertStyle(isError ? 'danger' : step === 4 ? 'success' : 'info')}>{statusMsg}</div>}

              <button
                style={primaryBtnStyle(!amountStr || isProcessing || isInsufficient)}
                onClick={executeBorrow}
                disabled={!amountStr || isProcessing || isInsufficient}
              >{isInsufficient ? 'Exceeds borrow limit' : isProcessing ? 'Processing…' : 'Borrow'}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
