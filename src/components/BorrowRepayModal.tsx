import { useState } from 'react'
import { useWriteContract, useAccount, useReadContract, useWaitForTransactionReceipt, useConfig, useBalance } from 'wagmi'
import { parseUnits, maxUint256, erc20Abi, formatUnits } from 'viem'
import { getChainConfig } from '../config/chains'
import { useAdjustedGas } from '../hooks/useAdjustedGas'
import { healthFactor, evaluateHf } from '../utils/health'
import { simulateAndWrite, approveAbi } from '../utils/contract'
import { GasInfoCard } from './GasInfoCard'
import { ExplorerLink } from './ExplorerLink'
import wethGatewayAbi from '../config/wethGatewayAbi.json'
import aavePoolAbi from '../config/aavev3Abi.json'
import { T, modalStyle, modalHeaderStyle, modalTitleStyle, closeButtonStyle, labelStyle, inputStyle, alertStyle, primaryBtnStyle } from '../styles/theme'

const RATE_MODE = 2n

const debtTokenAbi = [
  { inputs: [{ internalType: 'address', name: 'delegatee', type: 'address' }, { internalType: 'uint256', name: 'amount', type: 'uint256' }], name: 'approveDelegation', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [{ internalType: 'address', name: 'fromUser', type: 'address' }, { internalType: 'address', name: 'toUser', type: 'address' }], name: 'borrowAllowance', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' }
] as const

interface BorrowRepayModalProps {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  asset: any
  initialTab?: 'borrow' | 'repay'
  ethPriceUsd?: number
  collateralUsd?: number
  debtUsd?: number
  liquidationThreshold?: number
  onClose: () => void
}

const TAB_LABELS = { borrow: 'Borrow', repay: 'Repay' } as const

export function BorrowRepayModal({ asset, initialTab = 'borrow', ethPriceUsd = 0, collateralUsd = 0, debtUsd = 0, liquidationThreshold = 0, onClose }: BorrowRepayModalProps) {
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

  const { maxFee, maxPriority, estimatedFeeUsd } = useAdjustedGas(300000n /* Aave borrow/repay */, ethPriceUsd, parseFloat(amountStr) > 0, activeTab === 'borrow' ? 10n : 1n)

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
              priorityMultiplier: 10n
            })
            setTxHash(hash); setStep(2); log('Delegation approved. Click Borrow again to continue.')
            await refetchDelegation()
            return
          }

          log('Simulating ETH borrow…')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hash = await simulateAndWrite(config, writeContractAsync, { address: gatewayAddress, abi: wethGatewayAbi as any, functionName: 'borrowETH', args: [poolAddress, amountParsed, 0], priorityMultiplier: 10n })
          log(`Submitted: ${hash.slice(0, 10)}…`); setTxHash(hash); setStep(2); return
        }
        log('Simulating borrow…')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hash = await simulateAndWrite(config, writeContractAsync, { address: poolAddress, abi: aavePoolAbi as any, functionName: 'borrow', args: [asset.underlyingAsset, amountParsed, RATE_MODE, 0, address], priorityMultiplier: 10n })
        log(`Submitted: ${hash.slice(0, 10)}…`); setTxHash(hash); setStep(2)
      } else {
        if (isNativeEth && gatewayAddress) {
          log('Simulating ETH repay…')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hash = await simulateAndWrite(config, writeContractAsync, { address: gatewayAddress, abi: wethGatewayAbi as any, functionName: 'repayETH', args: [poolAddress, amountParsed, address], value: amountParsed })
          log(`Submitted: ${hash.slice(0, 10)}…`); setTxHash(hash); setStep(2); return
        }
        // For MAX repay we send maxUint256, and Aave pulls the *current* debt
        // (snapshot + interest accrued since load), so the approval must cover
        // more than `amountParsed`. Approve maxUint256 to guarantee it clears.
        const approveAmount = finalAmount === maxUint256 ? maxUint256 : amountParsed
        // Treat an unresolved read as zero so we approve rather than skipping
        // straight to a repay that would revert on insufficient allowance.
        const currentAllowance = (allowance as bigint) ?? 0n
        if (currentAllowance < approveAmount) {
          log('Simulating approval…')
          const approveHash = await simulateAndWrite(config, writeContractAsync, { address: asset.underlyingAsset, abi: approveAbi, functionName: 'approve', args: [poolAddress, approveAmount] })
          log('Approved — click Repay again.'); setTxHash(approveHash); setStep(0); await refetchAllowance(); return
        }
        log('Simulating repay…')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hash = await simulateAndWrite(config, writeContractAsync, { address: poolAddress, abi: aavePoolAbi as any, functionName: 'repay', args: [asset.underlyingAsset, finalAmount, RATE_MODE, address] })
        log(`Submitted: ${hash.slice(0, 10)}…`); setTxHash(hash); setStep(2)
      }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  const borrowRepayUsd = amountNum * (asset.priceInUsd ? parseFloat(asset.priceInUsd) : 0)
  const currentHealthFactor = healthFactor(collateralUsd * liquidationThreshold, debtUsd)
  const newHealthFactor = activeTab === 'borrow'
    ? healthFactor(collateralUsd * liquidationThreshold, debtUsd + borrowRepayUsd)
    : healthFactor(collateralUsd * liquidationThreshold, debtUsd - borrowRepayUsd)
  const hfGuard = evaluateHf(amountNum > 0 ? newHealthFactor : '∞')
  const hfGuardBlocked = hfGuard.level === 'block'

  const btnLabel = isInsufficientRepay ? 'Insufficient balance' : isOverRepay ? 'Exceeds debt' : hfGuardBlocked ? 'Health factor too low' : isProcessing ? 'Processing…' : TAB_LABELS[activeTab]

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-content" style={{ ...modalStyle, maxWidth: '440px' }}>
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
                onClick={() => { setAmountStr((asset.amount ?? 0).toFixed(asset.decimals)); setIsMax(true) }}
                style={{ position: 'absolute', right: '10px', bottom: '10px', padding: '2px 8px', fontSize: T.fontSize.xs, fontWeight: 700, color: T.primary, background: '#eff6ff', border: `1px solid #bfdbfe`, borderRadius: T.radius.sm, cursor: 'pointer' }}
              >MAX</button>
            )}
          </div>

          {/* Gas + health factor */}
          <GasInfoCard
            maxFee={maxFee}
            maxPriority={maxPriority}
            estimatedFeeUsd={estimatedFeeUsd}
            currentHealthFactor={amountNum > 0 ? currentHealthFactor : undefined}
            newHealthFactor={amountNum > 0 ? newHealthFactor : undefined}
          />

          {hfGuard.message && <div style={alertStyle(hfGuardBlocked ? 'danger' : 'warning')}>{hfGuard.message}</div>}
          {lastLog && <div style={alertStyle(isError ? 'danger' : 'success')}>{lastLog}</div>}
          {txHash && <ExplorerLink hash={txHash} chainId={chainId} />}

          <button
            style={primaryBtnStyle(isProcessing || !canExecute || isInsufficient || isOverRepay || hfGuardBlocked)}
            onClick={executeAction}
            disabled={isProcessing || !canExecute || isInsufficient || isOverRepay || hfGuardBlocked}
          >{btnLabel}</button>
        </div>
      </div>
    </div>
  )
}
