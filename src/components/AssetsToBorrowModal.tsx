import { useState } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useConfig, useReadContract } from 'wagmi'
import { parseUnits, maxUint256 } from 'viem'
import { getChainConfig } from '../config/chains'
import { useAdjustedGas } from '../hooks/useAdjustedGas'
import { healthFactor, evaluateHf } from '../utils/health'
import { simulateAndWrite } from '../utils/contract'
import { GasInfoCard } from './GasInfoCard'
import { ExplorerLink } from './ExplorerLink'
import wethGatewayAbi from '../config/wethGatewayAbi.json'
import aavePoolAbi from '../config/aavev3Abi.json'
import { T, modalStyle, modalHeaderStyle, modalTitleStyle, closeButtonStyle, labelStyle, inputStyle, alertStyle, primaryBtnStyle } from '../styles/theme'

interface AssetsToBorrowModalProps {
  chainId: number
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  availableReserves: any[]
  ethPriceUsd?: number
  availableBorrowsUsd?: number
  collateralUsd?: number
  debtUsd?: number
  liquidationThreshold?: number
  onClose: () => void
}

const RATE_MODE = 2n

const debtTokenAbi = [
  { inputs: [{ internalType: 'address', name: 'delegatee', type: 'address' }, { internalType: 'uint256', name: 'amount', type: 'uint256' }], name: 'approveDelegation', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [{ internalType: 'address', name: 'fromUser', type: 'address' }, { internalType: 'address', name: 'toUser', type: 'address' }], name: 'borrowAllowance', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' }
] as const

export function AssetsToBorrowModal({ chainId, availableReserves, ethPriceUsd = 0, availableBorrowsUsd = 0, collateralUsd = 0, debtUsd = 0, liquidationThreshold = 0, onClose }: AssetsToBorrowModalProps) {
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

  const { maxFee, maxPriority, estimatedFeeUsd } = useAdjustedGas(300000n /* Aave borrow */, ethPriceUsd, parseFloat(amountStr) > 0, 10n)

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
            functionName: 'approveDelegation', args: [gatewayAddress, maxUint256], priorityMultiplier: 10n
          })
          setTxHash(hash); setStep(2); setStatusMsg('Delegation approved. Click Borrow again to continue.')
          await refetchDelegation()
          return
        }

        setStep(3); setStatusMsg('Simulating borrowETH…')
        const hash = await simulateAndWrite(config, writeContractAsync, {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
          address: gatewayAddress, abi: wethGatewayAbi as any,
          functionName: 'borrowETH', args: [poolAddress, amountParsed, 0], priorityMultiplier: 10n
        })
        setTxHash(hash); setStep(4); setStatusMsg('Borrow transaction sent!')
        return
      }
      setStep(3); setStatusMsg('Simulating borrow…')
      const hash = await simulateAndWrite(config, writeContractAsync, {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        address: poolAddress, abi: aavePoolAbi as any,
        functionName: 'borrow', args: [selectedAsset.underlyingAsset as `0x${string}`, amountParsed, RATE_MODE, 0, address], priorityMultiplier: 10n
      })
      setTxHash(hash); setStep(4); setStatusMsg('Borrow transaction sent!')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  const borrowAmountUsd = amountNum * (Number(selectedAsset?.priceInUsd) || 0)
  const currentHealthFactor = healthFactor(collateralUsd * liquidationThreshold, debtUsd)
  const newHealthFactor = collateralUsd > 0
    ? healthFactor(collateralUsd * liquidationThreshold, debtUsd + borrowAmountUsd)
    : '∞'
  const hfGuard = evaluateHf(amountNum > 0 ? newHealthFactor : '∞')

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-content" style={{ ...modalStyle, maxWidth: '600px' }}>
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
                  <th className="align-right-desktop" style={{ paddingRight: T.space[5] }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {borrowOptions.map((opt) => (
                  <tr key={opt.symbol}>
                    <td style={{ paddingLeft: T.space[5] }}>
                      <div style={{ fontWeight: 600 }}>{opt.symbol}</div>
                      {opt.symbol !== 'ETH' && (
                        <div style={{ fontSize: '10px', color: T.textMuted, fontFamily: T.font.mono, marginTop: '2px' }} title={opt.underlyingAsset}>
                          {opt.underlyingAsset.slice(0, 6)}…{opt.underlyingAsset.slice(-4)}
                        </div>
                      )}
                    </td>
                    <td className="text-danger" style={{ fontFamily: T.font.mono }}>{opt.borrowApy?.toFixed(2) || '0.00'}%</td>
                    <td className="align-right-desktop" style={{ paddingRight: T.space[5] }}>
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
                onClick={executeBorrow}
                disabled={!amountStr || isProcessing || isInsufficient || hfGuard.level === 'block'}
              >{isInsufficient ? 'Exceeds borrow limit' : hfGuard.level === 'block' ? 'Health factor too low' : isProcessing ? 'Processing…' : 'Borrow'}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
