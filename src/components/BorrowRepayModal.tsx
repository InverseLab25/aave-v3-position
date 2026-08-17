import { useState } from 'react'
import { useWriteContract, useConnection, useReadContract, useWaitForTransactionReceipt, useConfig, useBalance } from 'wagmi'
import { parseUnits, maxUint256, erc20Abi, formatUnits } from 'viem'
import { getChainConfig } from '../config/chains'
import { useAdjustedGas } from '../hooks/useAdjustedGas'
import { healthFactor, evaluateHf } from '../utils/health'
import { simulateAndWrite, approveErc20 } from '../utils/contract'
import { maxNativeSpendable } from '../utils/maxAmount'
import { GasInfoCard } from './GasInfoCard'
import { ExplorerLink } from './ExplorerLink'
import { wethGatewayAbi } from '../config/wethGatewayAbi'
import { aavePoolAbi } from '../config/aavev3Abi'
import { computeLiquidationView } from '../utils/liquidation'
import type { SuppliedAssetLike } from '../utils/liquidation'
import type { BorrowedAsset } from '../hooks/useAavePositions'
import { extractRevertMessage } from '../utils/errors'
import { T, labelStyle, inputStyle, alertStyle, primaryBtnStyle, MODAL_WIDTH } from '../styles/theme'
import { Modal } from './Modal'

const RATE_MODE = 2n
const BORROW_REPAY_GAS_LIMIT = 300000n /* Aave borrow/repay */

/**
 * Overshoot applied to a MAX native-ETH repay (0.1%).
 *
 * `WrappedTokenGatewayV3.repayETH` repays the LIVE debt and refunds whatever
 * `msg.value` is left over, so overshooting the stale snapshot costs nothing but
 * covers the interest that accrues between page load and the tx being mined.
 */
const REPAY_INTEREST_BUFFER_BPS = 10n

const debtTokenAbi = [
  { inputs: [{ internalType: 'address', name: 'delegatee', type: 'address' }, { internalType: 'uint256', name: 'amount', type: 'uint256' }], name: 'approveDelegation', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [{ internalType: 'address', name: 'fromUser', type: 'address' }, { internalType: 'address', name: 'toUser', type: 'address' }], name: 'borrowAllowance', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' }
] as const

interface BorrowRepayModalProps {
  asset: BorrowedAsset
  initialTab?: 'borrow' | 'repay'
  ethPriceUsd?: number
  collateralUsd?: number
  debtUsd?: number
  liquidationThreshold?: number
  suppliedAssets?: SuppliedAssetLike[]
  onClose: () => void
}

const TAB_LABELS = { borrow: 'Borrow', repay: 'Repay' } as const

export function BorrowRepayModal({ asset, initialTab = 'borrow', ethPriceUsd = 0, collateralUsd = 0, debtUsd = 0, liquidationThreshold = 0, suppliedAssets = [], onClose }: BorrowRepayModalProps) {
  const { address, chainId } = useConnection()
  const chainConfig = getChainConfig(chainId)
  const poolAddress = chainConfig?.aave?.poolAddress as `0x${string}`
  const [activeTab, setActiveTab] = useState<'borrow' | 'repay'>(initialTab)
  const [amountStr, setAmountStr] = useState('')
  const [isMax, setIsMax] = useState(false)
  const [step, setStep] = useState(0)
  const [logs, setLogs] = useState<string[]>([])
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>(undefined)
  const [useNativeEth, setUseNativeEth] = useState(false)
  const isWeth = asset.symbol === 'WETH'
  const isNativeEth = asset.symbol === 'ETH' || (isWeth && useNativeEth)

  const { mutateAsync: writeContractAsync } = useWriteContract()
  const config = useConfig()
  const { isLoading: isWaitingTx } = useWaitForTransactionReceipt({ hash: txHash })

  const { maxFee, maxPriority, estimatedFeeUsd } = useAdjustedGas(BORROW_REPAY_GAS_LIMIT, ethPriceUsd, parseFloat(amountStr) > 0, activeTab === 'borrow' ? 10n : 1n)

  const gatewayAddress = chainConfig?.aave?.wethGateway as `0x${string}` | undefined

  const { data: allowance, refetch: refetchAllowance } = useReadContract({ chainId,
    address: asset.underlyingAsset, abi: erc20Abi, functionName: 'allowance',
    args: (address && poolAddress) ? [address, poolAddress] : undefined,
    query: { enabled: !!address && !!poolAddress && activeTab === 'repay' && !isNativeEth },
  })

  const { data: delegationAllowance, refetch: refetchDelegation } = useReadContract({ chainId,
    address: isNativeEth ? asset.variableDebtTokenAddress : undefined,
    abi: debtTokenAbi, functionName: 'borrowAllowance',
    args: (address && asset && isNativeEth && gatewayAddress) ? [address, gatewayAddress] : undefined,
    query: { enabled: !!address && !!asset && isNativeEth && !!gatewayAddress && activeTab === 'borrow' },
  })

  const { data: ethBalance } = useBalance({ chainId, address, query: { enabled: !!address && activeTab === 'repay' && isNativeEth } })
  const { data: tokenBalanceData } = useReadContract({ chainId,
    address: asset.underlyingAsset, abi: erc20Abi, functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address && activeTab === 'repay' && !isNativeEth },
  })

  const walletBalance = isNativeEth
    ? (ethBalance ? Number(formatUnits(ethBalance.value, ethBalance.decimals)) : 0)
    : (tokenBalanceData ? Number(formatUnits(tokenBalanceData as bigint, asset.decimals)) : 0)

  const log = (msg: string) => setLogs(p => [...p, msg])

  const executeAction = async () => {
    if (!address || !amountStr || !poolAddress) return
    try {
      setStep(1)
      const amountParsed = parseUnits(amountStr, asset.decimals)
      const finalAmount = isMax && activeTab === 'repay' ? maxUint256 : amountParsed

      if (activeTab === 'borrow') {
        if (isNativeEth && gatewayAddress) {
          const currentDelegation = (delegationAllowance as bigint) ?? 0n
          if (currentDelegation < amountParsed) {
            log('Simulating delegation approval…')
            const hash = await simulateAndWrite(config, writeContractAsync, { chainId,
              address: asset.variableDebtTokenAddress as `0x${string}`, abi: debtTokenAbi,
              functionName: 'approveDelegation', args: [gatewayAddress, maxUint256],
              priorityMultiplier: 10n
            })
            setTxHash(hash); setStep(2); log('Delegation approved. Click Borrow again to continue.')
            await refetchDelegation()
            return
          }

          log('Simulating ETH borrow…')
          const hash = await simulateAndWrite(config, writeContractAsync, { chainId, address: gatewayAddress, abi: wethGatewayAbi, functionName: 'borrowETH', args: [poolAddress, amountParsed, 0], priorityMultiplier: 10n })
          log(`Submitted: ${hash.slice(0, 10)}…`); setTxHash(hash); setStep(2); setAmountStr(''); return
        }
        log('Simulating borrow…')
        const hash = await simulateAndWrite(config, writeContractAsync, { chainId, address: poolAddress, abi: aavePoolAbi, functionName: 'borrow', args: [asset.underlyingAsset, amountParsed, RATE_MODE, 0, address], priorityMultiplier: 10n })
        log(`Submitted: ${hash.slice(0, 10)}…`); setTxHash(hash); setStep(2); setAmountStr('')
      } else {
        if (isNativeEth && gatewayAddress) {
          // `finalAmount` (maxUint256 on MAX) has to be threaded through here too:
          // passing the stale snapshot leaves the interest accrued since load as
          // dust debt. The gateway clamps the payback to the live debt and
          // refunds the unused msg.value, so we overshoot the snapshot — capped
          // so the wallet can still pay for gas.
          let repayAmount = amountParsed
          let repayValue = amountParsed
          if (isMax) {
            const spendable = maxNativeSpendable(ethBalance?.value ?? 0n, maxFee, BORROW_REPAY_GAS_LIMIT)
            const buffered = amountParsed + (amountParsed * REPAY_INTEREST_BUFFER_BPS) / 10_000n
            if (buffered <= spendable) {
              repayAmount = maxUint256
              repayValue = buffered
            } else {
              // Not enough ETH to clear the debt outright — repay what gas leaves us.
              repayAmount = spendable
              repayValue = spendable
            }
          }
          log('Simulating ETH repay…')
          const hash = await simulateAndWrite(config, writeContractAsync, { chainId, address: gatewayAddress, abi: wethGatewayAbi, functionName: 'repayETH', args: [poolAddress, repayAmount, address], value: repayValue })
          log(`Submitted: ${hash.slice(0, 10)}…`); setTxHash(hash); setStep(2); setAmountStr(''); return
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
          const approveHash = await approveErc20(config, writeContractAsync, {
            token: asset.underlyingAsset,
            spender: poolAddress,
            amount: approveAmount,
            currentAllowance,
          })
          log('Approved — click Repay again.'); setTxHash(approveHash); setStep(0); await refetchAllowance(); return
        }
        log('Simulating repay…')
        const hash = await simulateAndWrite(config, writeContractAsync, { chainId, address: poolAddress, abi: aavePoolAbi, functionName: 'repay', args: [asset.underlyingAsset, finalAmount, RATE_MODE, address] })
        log(`Submitted: ${hash.slice(0, 10)}…`); setTxHash(hash); setStep(2); setAmountStr('')
      }
    } catch (e) {
      const reason = extractRevertMessage(e)
      log(`Error: ${reason}`); setStep(0)
    }
  }

  const isProcessing = step === 1 || step === 3 || isWaitingTx
  const canExecute = !!amountStr && parseFloat(amountStr) > 0
  const lastLog = logs[logs.length - 1] ?? ''
  const isError = lastLog.startsWith('Error')

  // Size MAX from the raw debt balance — `asset.amount` is a double and
  // `.toFixed(decimals)` on it drifts from the true balance by a few wei.
  const maxRepayableStr = asset.amountRaw !== undefined
    ? formatUnits(asset.amountRaw as bigint, asset.decimals)
    : (asset.amount ?? 0).toFixed(asset.decimals)

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

  const newDebtUsd = activeTab === 'borrow' ? debtUsd + borrowRepayUsd : Math.max(0, debtUsd - borrowRepayUsd);
  
  const liquidationView = computeLiquidationView(
    suppliedAssets.map((a: SuppliedAssetLike) => ({
      symbol: a.symbol,
      amount: a.amount || 0,
      priceUsd: a.priceInUsd ? parseFloat(a.priceInUsd) : 0,
      liquidationThreshold: a.liquidationThreshold || 0
    })),
    newDebtUsd
  )

  const btnLabel = isInsufficientRepay ? 'Insufficient balance' : isOverRepay ? 'Exceeds debt' : hfGuardBlocked ? 'Health factor too low' : isProcessing ? 'Processing…' : TAB_LABELS[activeTab]

  return (
    <Modal
      title={asset.symbol}
      onClose={onClose}
      maxWidth={MODAL_WIDTH.form}
      dismissable={!isProcessing}
      // In the shell's footer, not trailing the body — see WithdrawModal.
      footer={
        <>
          <button onClick={onClose} className="btn-secondary" style={{ flex: 1, padding: '10px' }}>
            Cancel
          </button>
          <button
            style={{ ...primaryBtnStyle(isProcessing || !canExecute || isInsufficient || isOverRepay || hfGuardBlocked), flex: 1, width: 'auto' }}
            onClick={executeAction}
            disabled={isProcessing || !canExecute || isInsufficient || isOverRepay || hfGuardBlocked}
          >
            {btnLabel}
          </button>
        </>
      }
    >

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
        {/* No padding of its own: the shell's `.modal-body` already supplies it, and both together
                        inset the content twice as far as the header above it. */}
        <div>
          {activeTab === 'repay' && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: T.fontSize.sm, color: T.textMuted, marginBottom: T.space[3] }}>
              <span>Outstanding debt</span>
              <span className="text-danger" style={{ fontFamily: T.font.mono, fontWeight: 600 }}>{asset.amount?.toFixed(4) ?? '0.00'} {asset.symbol}</span>
            </div>
          )}

          {isWeth && gatewayAddress && (
            <div style={{ display: 'flex', alignItems: 'center', gap: T.space[2], marginBottom: T.space[4] }}>
              <input type="checkbox" id="useNativeEth" checked={useNativeEth} onChange={e => setUseNativeEth(e.target.checked)} />
              <label htmlFor="useNativeEth" style={{ fontSize: T.fontSize.sm, color: T.text, cursor: 'pointer' }}>Use native ETH to {activeTab}</label>
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
                onClick={() => { setAmountStr(maxRepayableStr); setIsMax(true) }}
                style={{ position: 'absolute', right: '10px', bottom: '10px', padding: '2px 8px', fontSize: T.fontSize.xs, fontWeight: 700, color: T.primary, background: 'transparent', border: `1px solid ${T.border}`, borderRadius: T.radius.sm, cursor: 'pointer' }}
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
            liquidationView={amountNum > 0 ? liquidationView : undefined}
          />

          {hfGuard.message && <div style={alertStyle(hfGuardBlocked ? 'danger' : 'warning')}>{hfGuard.message}</div>}
          {lastLog && <div style={alertStyle(isError ? 'danger' : 'success')}>{lastLog}</div>}
          {txHash && <ExplorerLink hash={txHash} chainId={chainId} />}

        </div>
    </Modal>
  )
}
