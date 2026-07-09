import { useState } from 'react'
import { useWriteContract, useAccount, useReadContract, useWaitForTransactionReceipt, useConfig } from 'wagmi'
import { parseUnits, maxUint256, erc20Abi } from 'viem'
import { getChainConfig } from '../config/chains'
import { useAdjustedGas } from '../hooks/useAdjustedGas'
import { healthFactor, evaluateHf } from '../utils/health'
import { simulateAndWrite, approveAbi } from '../utils/contract'
import { GasInfoCard } from './GasInfoCard'
import { ExplorerLink } from './ExplorerLink'
import wethGatewayAbi from '../config/wethGatewayAbi.json'
import aavePoolAbi from '../config/aavev3Abi.json'
import { T, modalStyle, modalHeaderStyle, modalTitleStyle, closeButtonStyle, labelStyle, inputStyle, alertStyle, primaryBtnStyle } from '../styles/theme'

interface WithdrawModalProps {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  asset: any
  ethPriceUsd?: number
  collateralUsd?: number
  debtUsd?: number
  liquidationThreshold?: number
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  availableReserves?: any[]
  onClose: () => void
}

export function WithdrawModal({ asset, ethPriceUsd = 0, collateralUsd = 0, debtUsd = 0, liquidationThreshold = 0, availableReserves = [], onClose }: WithdrawModalProps) {
  const { address, chainId } = useAccount()
  const chainConfig = getChainConfig(chainId)
  const poolAddress = chainConfig?.aave?.poolAddress as `0x${string}`
  const [amountStr, setAmountStr] = useState('')
  const [isMax, setIsMax] = useState(false)
  const [step, setStep] = useState(0)
  const [logs, setLogs] = useState<string[]>([])
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>(undefined)

  const { writeContractAsync } = useWriteContract()
  const config = useConfig()
  const { isLoading: isWaitingTx } = useWaitForTransactionReceipt({ hash: txHash })

  const { maxFee, maxPriority, estimatedFeeUsd } = useAdjustedGas(250000n /* Aave withdraw */, ethPriceUsd, parseFloat(amountStr) > 0)

  const { data: aTokenAllowance, refetch: refetchATokenAllowance } = useReadContract({
    address: asset?.symbol === 'ETH' ? asset.aTokenAddress : undefined,
    abi: erc20Abi, functionName: 'allowance',
    args: (address && asset && asset.symbol === 'ETH' && chainConfig?.aave?.wethGateway) ? [address, chainConfig.aave.wethGateway] : undefined,
    query: { enabled: !!address && !!asset && asset.symbol === 'ETH' && !!chainConfig?.aave?.wethGateway },
  })

  const log = (msg: string) => setLogs(p => [...p, msg])

  const executeAction = async () => {
    if (!address || !amountStr || !poolAddress) return
    try {
      setStep(1)
      const amountParsed = parseUnits(amountStr, asset.decimals)
      const finalAmount = isMax ? maxUint256 : amountParsed
      const gatewayAddress = chainConfig?.aave?.wethGateway as `0x${string}` | undefined

      if (asset.symbol === 'ETH' && gatewayAddress) {
        const currentAllowance = (aTokenAllowance as bigint) ?? 0n
        if (currentAllowance < amountParsed) {
          log('Simulating aToken approval…')
          const approveHash = await simulateAndWrite(config, writeContractAsync, { address: asset.aTokenAddress, abi: approveAbi, functionName: 'approve', args: [gatewayAddress, maxUint256] })
          log('Approved — click Withdraw again.'); setTxHash(approveHash); setStep(0); await refetchATokenAllowance(); return
        }
        log('Simulating ETH withdraw…')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hash = await simulateAndWrite(config, writeContractAsync, { address: gatewayAddress, abi: wethGatewayAbi as any, functionName: 'withdrawETH', args: [poolAddress, finalAmount, address] })
        log(`Submitted: ${hash.slice(0, 10)}…`); setTxHash(hash); setStep(2); return
      }

      log('Simulating withdraw…')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hash = await simulateAndWrite(config, writeContractAsync, { address: poolAddress, abi: aavePoolAbi as any, functionName: 'withdraw', args: [asset.underlyingAsset, finalAmount, address] })
      log(`Submitted: ${hash.slice(0, 10)}…`); setTxHash(hash); setStep(2)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      const reason = e?.cause?.reason ?? e?.shortMessage ?? e?.message ?? String(e)
      log(`Error: ${reason}`); setStep(0)
    }
  }

  const isProcessing = step === 1 || isWaitingTx
  const canExecute = !!amountStr && parseFloat(amountStr) > 0
  const lastLog = logs[logs.length - 1] ?? ''
  const isError = lastLog.startsWith('Error')

  const amountNum = parseFloat(amountStr) || 0
  const isInsufficient = amountNum > (asset.amount || 0)

  const targetReserve = availableReserves.find(r => r.symbol === asset.symbol)
  const assetLT = targetReserve ? targetReserve.liquidationThreshold : 0
  const withdrawUsd = amountNum * (asset.priceInUsd ? parseFloat(asset.priceInUsd) : 0)

  const currentHealthFactor = healthFactor(collateralUsd * liquidationThreshold, debtUsd)
  const newHealthFactor = assetLT > 0
    ? healthFactor(collateralUsd * liquidationThreshold - withdrawUsd * assetLT, debtUsd)
    : '∞'
  const hfGuard = evaluateHf(amountNum > 0 ? newHealthFactor : '∞')
  const hfGuardBlocked = hfGuard.level === 'block'

  const btnLabel = isInsufficient ? 'Insufficient supplied' : hfGuardBlocked ? 'Health factor too low' : isProcessing ? 'Processing…' : 'Withdraw'

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ ...modalStyle, maxWidth: '440px' }}>
        {/* Header */}
        <div style={modalHeaderStyle}>
          <h2 style={modalTitleStyle}>Withdraw {asset.symbol}</h2>
          <button style={closeButtonStyle} onClick={onClose}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: T.space[5] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: T.fontSize.sm, color: T.textMuted, marginBottom: T.space[3] }}>
            <span>Available to withdraw</span>
            <span style={{ color: T.text, fontFamily: T.font.mono, fontWeight: 600 }}>{asset.amount?.toFixed(4) ?? '0.00'} {asset.symbol}</span>
          </div>

          {/* Amount input */}
          <div style={{ marginBottom: T.space[4], position: 'relative' }}>
            <label style={labelStyle}>Amount</label>
            <input
              type="number" value={amountStr}
              onChange={e => { setAmountStr(e.target.value); setIsMax(false) }}
              placeholder="0.00"
              style={{ ...inputStyle, paddingRight: '56px' }}
              onFocus={e => (e.currentTarget.style.borderColor = T.borderFocus)}
              onBlur={e => (e.currentTarget.style.borderColor = T.border)}
            />
            <button
              onClick={() => { setAmountStr(asset.amount?.toString() ?? '0'); setIsMax(true) }}
              style={{ position: 'absolute', right: '10px', bottom: '10px', padding: '2px 8px', fontSize: T.fontSize.xs, fontWeight: 700, color: T.primary, background: '#eff6ff', border: `1px solid #bfdbfe`, borderRadius: T.radius.sm, cursor: 'pointer' }}
            >MAX</button>
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
            style={primaryBtnStyle(isProcessing || !canExecute || isInsufficient || hfGuardBlocked)}
            onClick={executeAction}
            disabled={isProcessing || !canExecute || isInsufficient || hfGuardBlocked}
          >{btnLabel}</button>
        </div>
      </div>
    </div>
  )
}
