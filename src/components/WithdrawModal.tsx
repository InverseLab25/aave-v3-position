import { useState } from 'react'
import { useWriteContract, useConnection, useReadContract, useWaitForTransactionReceipt, useConfig } from 'wagmi'
import { parseUnits, formatUnits, maxUint256, erc20Abi } from 'viem'
import { getChainConfig } from '../config/chains'
import { useAdjustedGas } from '../hooks/useAdjustedGas'
import { healthFactor, evaluateHf } from '../utils/health'
import { simulateAndWrite, approveAbi } from '../utils/contract'
import { GasInfoCard } from './GasInfoCard'
import { Modal } from './Modal'
import { ExplorerLink } from './ExplorerLink'
import { computeLiquidationView } from '../utils/liquidation'
import type { SuppliedAssetLike } from '../utils/liquidation'
import type { AvailableReserve, SuppliedAsset } from '../hooks/useAavePositions'
import { extractRevertMessage } from '../utils/errors'
import { wethGatewayAbi } from '../config/wethGatewayAbi'
import { aavePoolAbi } from '../config/aavev3Abi'
import { T, labelStyle, inputStyle, alertStyle, primaryBtnStyle, MODAL_WIDTH } from '../styles/theme'

interface WithdrawModalProps {
  asset: SuppliedAsset
  ethPriceUsd?: number
  collateralUsd?: number
  debtUsd?: number
  liquidationThreshold?: number
  suppliedAssets?: SuppliedAssetLike[]
  availableReserves?: AvailableReserve[]
  onClose: () => void
}

export function WithdrawModal({ asset, ethPriceUsd = 0, collateralUsd = 0, debtUsd = 0, liquidationThreshold = 0, suppliedAssets = [], availableReserves = [], onClose }: WithdrawModalProps) {
  const { address, chainId } = useConnection()
  const chainConfig = getChainConfig(chainId)
  const poolAddress = chainConfig?.aave?.poolAddress as `0x${string}`
  const [amountStr, setAmountStr] = useState('')
  const [isMax, setIsMax] = useState(false)
  const [step, setStep] = useState(0)
  const [logs, setLogs] = useState<string[]>([])
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>(undefined)
  /**
   * Take the wrapped native back out as the native coin.
   *
   * Aave holds WETH and its reserve reports the symbol WETH, never ETH — so the gateway path below
   * existed but nothing on these chains could reach it, and a user with WETH collateral could only
   * ever take WETH back out. Same shape as the toggle in BorrowRepayModal.
   */
  const [unwrapToEth, setUnwrapToEth] = useState(false)

  const gatewayAddress = chainConfig?.aave?.wethGateway as `0x${string}` | undefined
  const isWeth = asset.symbol === 'WETH'
  /** Either the reserve IS the native coin, or it is the wrapper and the user asked to unwrap. */
  const isNativeEth = asset.symbol === 'ETH' || (isWeth && unwrapToEth)
  const canUnwrap = isWeth && !!gatewayAddress

  const { mutateAsync: writeContractAsync } = useWriteContract()
  const config = useConfig()
  const { isLoading: isWaitingTx } = useWaitForTransactionReceipt({ hash: txHash })

  const { maxFee, maxPriority, estimatedFeeUsd } = useAdjustedGas(250000n /* Aave withdraw */, ethPriceUsd, parseFloat(amountStr) > 0)

  const { data: aTokenAllowance, refetch: refetchATokenAllowance } = useReadContract({ chainId,
    address: isNativeEth ? asset.aTokenAddress : undefined,
    abi: erc20Abi, functionName: 'allowance',
    args: address && isNativeEth && gatewayAddress ? [address, gatewayAddress] : undefined,
    query: { enabled: !!address && isNativeEth && !!gatewayAddress },
  })

  const log = (msg: string) => setLogs(p => [...p, msg])

  const executeAction = async () => {
    if (!address || !amountStr || !poolAddress) return
    try {
      setStep(1)
      const amountParsed = parseUnits(amountStr, asset.decimals)
      const finalAmount = isMax ? maxUint256 : amountParsed
      if (isNativeEth && gatewayAddress) {
        const currentAllowance = (aTokenAllowance as bigint) ?? 0n
        if (currentAllowance < amountParsed) {
          log('Simulating aToken approval…')
          const approveHash = await simulateAndWrite(config, writeContractAsync, { chainId, address: asset.aTokenAddress, abi: approveAbi, functionName: 'approve', args: [gatewayAddress, maxUint256] })
          log('Approved — click Withdraw again.'); setTxHash(approveHash); setStep(0); await refetchATokenAllowance(); return
        }
        log('Simulating ETH withdraw…')
        const hash = await simulateAndWrite(config, writeContractAsync, { chainId, address: gatewayAddress, abi: wethGatewayAbi, functionName: 'withdrawETH', args: [poolAddress, finalAmount, address] })
        log(`Submitted: ${hash.slice(0, 10)}…`); setTxHash(hash); setStep(2); setAmountStr(''); return
      }

      log('Simulating withdraw…')
      const hash = await simulateAndWrite(config, writeContractAsync, { chainId, address: poolAddress, abi: aavePoolAbi, functionName: 'withdraw', args: [asset.underlyingAsset, finalAmount, address] })
      log(`Submitted: ${hash.slice(0, 10)}…`); setTxHash(hash); setStep(2); setAmountStr('')
    } catch (e) {
      const reason = extractRevertMessage(e)
      log(`Error: ${reason}`); setStep(0)
    }
  }

  const isProcessing = step === 1 || isWaitingTx
  const canExecute = !!amountStr && parseFloat(amountStr) > 0
  const lastLog = logs[logs.length - 1] ?? ''
  const isError = lastLog.startsWith('Error')

  // Size MAX from the raw aToken balance, not from `asset.amount` — that is a
  // double, and `.toFixed(decimals)` on it drifts from the true balance in both
  // directions. An overshoot survives as long as `isMax` holds (we send
  // maxUint256), but the moment the user edits the field `isMax` clears and the
  // drifted value is what goes on-chain.
  const maxWithdrawableStr = asset.amountRaw !== undefined
    ? formatUnits(asset.amountRaw as bigint, asset.decimals)
    : (asset.amount ?? 0).toFixed(asset.decimals)

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

  const liquidationView = computeLiquidationView(
    suppliedAssets.map((a: SuppliedAssetLike) => {
      const isTarget = a.symbol === asset.symbol;
      const originalAmount = a.amount || 0;
      return {
        symbol: a.symbol,
        amount: isTarget ? Math.max(0, originalAmount - amountNum) : originalAmount,
        priceUsd: a.priceInUsd ? parseFloat(a.priceInUsd) : 0,
        liquidationThreshold: a.liquidationThreshold || 0
      }
    }),
    debtUsd
  )

  const btnLabel = isInsufficient ? 'Insufficient supplied' : hfGuardBlocked ? 'Health factor too low' : isProcessing ? 'Processing…' : 'Withdraw'

  return (
    <Modal
      title={`Withdraw ${asset.symbol}`}
      onClose={onClose}
      maxWidth={MODAL_WIDTH.form}
      dismissable={!isProcessing}
      // In the shell's footer, not trailing the body. Inline it scrolled away with the form and
      // sat at a different inset from every other modal's actions.
      footer={
        <>
          <button onClick={onClose} className="btn-secondary" style={{ flex: 1, padding: '10px' }}>
            Cancel
          </button>
          <button
            style={{ ...primaryBtnStyle(isProcessing || !canExecute || isInsufficient || hfGuardBlocked), flex: 1, width: 'auto' }}
            onClick={executeAction}
            disabled={isProcessing || !canExecute || isInsufficient || hfGuardBlocked}
          >
            {btnLabel}
          </button>
        </>
      }
    >
        {/* No padding of its own: the shell's `.modal-body` already supplies it, and both together
                        inset the content twice as far as the header above it. */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: T.fontSize.sm, color: T.textMuted, marginBottom: T.space[3] }}>
            <span>Available to withdraw</span>
            <span style={{ color: T.text, fontFamily: T.font.mono, fontWeight: 600 }}>{asset.amount?.toFixed(4) ?? '0.00'} {asset.symbol}</span>
          </div>

          {canUnwrap && (
            <div style={{ display: 'flex', alignItems: 'center', gap: T.space[2], marginBottom: T.space[4] }}>
              <input
                type="checkbox"
                id="unwrapToEth"
                checked={unwrapToEth}
                onChange={(e) => setUnwrapToEth(e.target.checked)}
              />
              <label htmlFor="unwrapToEth" style={{ fontSize: T.fontSize.sm, color: T.text, cursor: 'pointer' }}>
                Withdraw as ETH
              </label>
            </div>
          )}

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
              onClick={() => { setAmountStr(maxWithdrawableStr); setIsMax(true) }}
              style={{ position: 'absolute', right: '10px', bottom: '10px', padding: '2px 8px', fontSize: T.fontSize.xs, fontWeight: 700, color: T.primary, background: 'transparent', border: `1px solid ${T.border}`, borderRadius: T.radius.sm, cursor: 'pointer' }}
            >MAX</button>
          </div>

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
