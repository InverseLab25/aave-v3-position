import { useState } from 'react'
import { useWriteContract, useAccount, useReadContract, useWaitForTransactionReceipt, useConfig, useEstimateFeesPerGas, useBalance } from 'wagmi'
import { parseUnits, maxUint256, erc20Abi, formatGwei, formatUnits } from 'viem'
import { getChainConfig } from '../config/chains'
import { calculateAdjustedFees } from '../utils/gas'
import { simulateAndWrite } from '../utils/contract'
import wethGatewayAbi from '../config/wethGatewayAbi.json'
import aavePoolAbi from '../config/aavev3Abi.json'
import { T, modalStyle, modalHeaderStyle, modalTitleStyle, closeButtonStyle, labelStyle, inputStyle, infoCardStyle, alertStyle, primaryBtnStyle } from '../styles/theme'

const RATE_MODE = 2n

const debtTokenAbi = [
  { inputs: [{ internalType: 'address', name: 'delegatee', type: 'address' }, { internalType: 'uint256', name: 'amount', type: 'uint256' }], name: 'approveDelegation', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [{ internalType: 'address', name: 'fromUser', type: 'address' }, { internalType: 'address', name: 'toUser', type: 'address' }], name: 'borrowAllowance', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' }
] as const

interface BorrowRepayModalProps {
  asset: any
  initialTab?: 'borrow' | 'repay'
  ethPriceUsd?: number
  onClose: () => void
}

const TAB_LABELS = { borrow: 'Borrow', repay: 'Repay' } as const

export function BorrowRepayModal({ asset, initialTab = 'borrow', ethPriceUsd = 0, onClose }: BorrowRepayModalProps) {
  const { address, chainId } = useAccount()
  const chainConfig = getChainConfig(chainId)
  const poolAddress = chainConfig?.aave?.poolAddress as `0x${string}`
  const [activeTab, setActiveTab] = useState<'borrow' | 'repay'>(initialTab)
  const [amountStr, setAmountStr] = useState('')
  const [isMax, setIsMax] = useState(false)
  const [step, setStep] = useState(0)
  const [logs, setLogs] = useState<string[]>([])
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>(undefined)

  const { writeContractAsync } = useWriteContract()
  const config = useConfig()
  const { isLoading: isWaitingTx } = useWaitForTransactionReceipt({ hash: txHash })

  const { data: feeData } = useEstimateFeesPerGas()
  const { adjustedMaxFeePerGas: uiMaxFee, adjustedMaxPriorityFeePerGas: uiMaxPriority } =
    calculateAdjustedFees(feeData?.maxFeePerGas, feeData?.maxPriorityFeePerGas)

  const gatewayAddress = chainConfig?.aave?.wethGateway as `0x${string}` | undefined

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: asset.underlyingAsset, abi: erc20Abi, functionName: 'allowance',
    args: (address && poolAddress) ? [address, poolAddress] : undefined,
    query: { enabled: !!address && !!poolAddress && activeTab === 'repay' && asset.symbol !== 'ETH' },
  })

  const { data: delegationAllowance, refetch: refetchDelegation } = useReadContract({
    address: asset?.symbol === 'ETH' ? asset.variableDebtTokenAddress : undefined,
    abi: debtTokenAbi, functionName: 'borrowAllowance',
    args: (address && asset && asset.symbol === 'ETH' && gatewayAddress) ? [address, gatewayAddress] : undefined,
    query: { enabled: !!address && !!asset && asset.symbol === 'ETH' && !!gatewayAddress && activeTab === 'borrow' },
  })

  const { data: ethBalance } = useBalance({ address, query: { enabled: !!address && activeTab === 'repay' && asset.symbol === 'ETH' } })
  const { data: tokenBalanceData } = useReadContract({
    address: asset.underlyingAsset, abi: erc20Abi, functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address && activeTab === 'repay' && asset.symbol !== 'ETH' },
  })

  const walletBalance = asset.symbol === 'ETH'
    ? (ethBalance ? Number(formatUnits(ethBalance.value, ethBalance.decimals)) : 0)
    : (tokenBalanceData ? Number(formatUnits(tokenBalanceData as bigint, asset.decimals)) : 0)

  const log = (msg: string) => setLogs(p => [...p, msg])

  const executeAction = async () => {
    if (!address || !amountStr || !poolAddress) return
    try {
      setStep(1)
      const amountParsed = parseUnits(amountStr, asset.decimals)
      const finalAmount = isMax && activeTab === 'repay' ? maxUint256 : amountParsed
      const isNativeEth = asset.symbol === 'ETH'

      if (activeTab === 'borrow') {
        if (isNativeEth && gatewayAddress) {
          const currentDelegation = (delegationAllowance as bigint) ?? 0n
          if (currentDelegation < amountParsed) {
            log('Simulating delegation approval…')
            const hash = await simulateAndWrite(config, writeContractAsync, {
              address: asset.variableDebtTokenAddress as `0x${string}`, abi: debtTokenAbi,
              functionName: 'approveDelegation', args: [gatewayAddress, maxUint256],
            })
            setTxHash(hash); setStep(2); log('Delegation approved. Click Borrow again to continue.')
            await refetchDelegation()
            return
          }

          log('Simulating ETH borrow…')
          const hash = await simulateAndWrite(config, writeContractAsync, { address: gatewayAddress, abi: wethGatewayAbi as any, functionName: 'borrowETH', args: [poolAddress, amountParsed, RATE_MODE, 0] })
          log(`Submitted: ${hash.slice(0, 10)}…`); setTxHash(hash); setStep(2); return
        }
        log('Simulating borrow…')
        const hash = await simulateAndWrite(config, writeContractAsync, { address: poolAddress, abi: aavePoolAbi as any, functionName: 'borrow', args: [asset.underlyingAsset, amountParsed, RATE_MODE, 0, address] })
        log(`Submitted: ${hash.slice(0, 10)}…`); setTxHash(hash); setStep(2)
      } else {
        if (isNativeEth && gatewayAddress) {
          log('Simulating ETH repay…')
          const hash = await simulateAndWrite(config, writeContractAsync, { address: gatewayAddress, abi: wethGatewayAbi as any, functionName: 'repayETH', args: [poolAddress, amountParsed, RATE_MODE, address], value: amountParsed })
          log(`Submitted: ${hash.slice(0, 10)}…`); setTxHash(hash); setStep(2); return
        }
        if (allowance !== undefined && allowance < amountParsed) {
          log('Simulating approval…')
          const approveHash = await simulateAndWrite(config, writeContractAsync, { address: asset.underlyingAsset, abi: erc20Abi, functionName: 'approve', args: [poolAddress, amountParsed] })
          log('Approved — click Repay again.'); setTxHash(approveHash); setStep(0); await refetchAllowance(); return
        }
        log('Simulating repay…')
        const hash = await simulateAndWrite(config, writeContractAsync, { address: poolAddress, abi: aavePoolAbi as any, functionName: 'repay', args: [asset.underlyingAsset, finalAmount, RATE_MODE, address] })
        log(`Submitted: ${hash.slice(0, 10)}…`); setTxHash(hash); setStep(2)
      }
    } catch (e: any) {
      const reason = e?.cause?.reason ?? e?.shortMessage ?? e?.message ?? String(e)
      log(`Error: ${reason}`); setStep(0)
    }
  }

  const isProcessing = step === 1 || step === 3 || isWaitingTx
  const canExecute = !!amountStr && parseFloat(amountStr) > 0
  const lastLog = logs[logs.length - 1] ?? ''
  const isError = lastLog.startsWith('Error')

  const amountNum = parseFloat(amountStr) || 0
  const isInsufficientRepay = activeTab === 'repay' && amountNum > Math.max(0, walletBalance)
  const isOverRepay = activeTab === 'repay' && amountNum > (asset.amount || 0)

  const isInsufficient = isInsufficientRepay
  const btnLabel = isInsufficientRepay ? 'Insufficient balance' : isOverRepay ? 'Exceeds debt' : isProcessing ? 'Processing…' : TAB_LABELS[activeTab]

  const assumedGasLimit = 300000n // Rough estimate for Aave borrow/repay
  const estimatedFeeUsd = (uiMaxFee && ethPriceUsd > 0) ? Number(formatUnits(uiMaxFee * assumedGasLimit, 18)) * ethPriceUsd : 0

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ ...modalStyle, maxWidth: '440px' }}>
        {/* Header */}
        <div style={modalHeaderStyle}>
          <h2 style={modalTitleStyle}>{asset.symbol}</h2>
          <button style={closeButtonStyle} onClick={onClose}>×</button>
        </div>

        {/* Underline tabs */}
        <div style={{ display: 'flex', gap: T.space[1], padding: `${T.space[3]} ${T.space[5]} 0`, borderBottom: `1px solid ${T.border}` }}>
          {(['borrow', 'repay'] as const).map(tab => (
            <button key={tab}
              onClick={() => { setActiveTab(tab); setAmountStr(''); setIsMax(false); setLogs([]); setStep(0) }}
              style={{
                padding: `6px ${T.space[4]}`, fontSize: T.fontSize.sm, fontWeight: 600,
                border: 'none', borderRadius: `${T.radius.sm} ${T.radius.sm} 0 0`,
                cursor: 'pointer', background: 'none',
                color: activeTab === tab ? T.primary : T.textMuted,
                borderBottom: activeTab === tab ? `2px solid ${T.primary}` : '2px solid transparent',
                marginBottom: '-1px', transition: T.transition,
              }}
            >{TAB_LABELS[tab]}</button>
          ))}
        </div>

        {/* Body */}
        <div style={{ padding: T.space[5] }}>
          {activeTab === 'repay' && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: T.fontSize.sm, color: T.textMuted, marginBottom: T.space[3] }}>
              <span>Outstanding debt</span>
              <span className="text-danger" style={{ fontFamily: T.font.mono, fontWeight: 600 }}>{asset.amount?.toFixed(4) ?? '0.00'} {asset.symbol}</span>
            </div>
          )}

          {/* Amount input */}
          <div style={{ marginBottom: T.space[4], position: 'relative' }}>
            <label style={labelStyle}>Amount</label>
            <input
              type="number" value={amountStr}
              onChange={e => { setAmountStr(e.target.value); setIsMax(false) }}
              placeholder="0.00"
              style={{ ...inputStyle, paddingRight: activeTab === 'repay' ? '56px' : '12px' }}
              onFocus={e => (e.currentTarget.style.borderColor = T.borderFocus)}
              onBlur={e => (e.currentTarget.style.borderColor = T.border)}
            />
            {activeTab === 'repay' && (
              <button
                onClick={() => { setAmountStr(asset.amount?.toString() ?? '0'); setIsMax(true) }}
                style={{ position: 'absolute', right: '10px', bottom: '10px', padding: '2px 8px', fontSize: T.fontSize.xs, fontWeight: 700, color: T.primary, background: '#eff6ff', border: `1px solid #bfdbfe`, borderRadius: T.radius.sm, cursor: 'pointer' }}
              >MAX</button>
            )}
          </div>

          {/* Gas Info */}
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

          {lastLog && <div style={alertStyle(isError ? 'danger' : 'success')}>{lastLog}</div>}

          <button
            style={primaryBtnStyle(isProcessing || !canExecute || isInsufficient || isOverRepay)}
            onClick={executeAction}
            disabled={isProcessing || !canExecute || isInsufficient || isOverRepay}
          >{btnLabel}</button>
        </div>
      </div>
    </div>
  )
}
