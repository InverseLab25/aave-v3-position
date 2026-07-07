import { useState } from 'react'
import { useWriteContract, useAccount, useChainId, useConfig } from 'wagmi'
import { parseUnits, maxUint256, formatGwei } from 'viem'
import { getChainConfig, getDeleveragerAddress } from '../config/chains'
import aavePoolAbi from '../config/aavev3Abi.json'
import { useAdjustedGas } from '../hooks/useAdjustedGas'

import { simulateAndWrite } from '../utils/contract'
import { useDeleverageClose } from '../hooks/useDeleverageClose'

const SLIPPAGE_PRESETS = [0.1, 0.5, 1]

interface ClosePositionModalProps {
  borrowedAsset: any
  suppliedAssets: any[]
  onClose: () => void
}

export function ClosePositionModal({ borrowedAsset, suppliedAssets, onClose }: ClosePositionModalProps) {
  const { address } = useAccount()
  const chainId = useChainId()
  const [selectedCollateral, setSelectedCollateral] = useState<any>(suppliedAssets[0] || null)
  const [amountStr, setAmountStr] = useState<string>('')
  const [isMax, setIsMax] = useState<boolean>(false)
  const [slippage, setSlippage] = useState<number>(0.5)

  const [step, setStep] = useState<number>(0)
  const [logs, setLogs] = useState<string[]>([])

  const { mutateAsync: writeContractAsync } = useWriteContract()
  const config = useConfig()
  const deleverage = useDeleverageClose()
  const chainConfig = getChainConfig(chainId)
  const poolAddress = chainConfig?.aave?.poolAddress as `0x${string}`

  const isSameAsset =
    selectedCollateral?.underlyingAsset?.toLowerCase() === borrowedAsset.underlyingAsset.toLowerCase()
  const deleveragerAvailable = getDeleveragerAddress(chainId) !== null

  // Only estimate once there's something to act on: an entered amount for the
  // same-asset repay, or an available one-click close for the cross-asset path.
  const { maxFee: uiMaxFee, maxPriority: uiMaxPriority } = useAdjustedGas(
    300000n /* deleverage close */, 0,
    isSameAsset ? parseFloat(amountStr) > 0 : deleveragerAvailable,
  )

  const log = (msg: string) => setLogs((prev) => [...prev, msg])

  const executeClose = async () => {
    if (!address || !selectedCollateral || !poolAddress) return

    if (isSameAsset) {
      if (!amountStr) return
      try {
        setStep(1)
        const amountParsed = parseUnits(amountStr, borrowedAsset.decimals)
        const finalAmount = isMax ? maxUint256 : amountParsed
        log(`Simulating repayWithATokens for ${isMax ? 'MAX' : amountStr} ${borrowedAsset.symbol}…`)
        const txHash = await simulateAndWrite(config, writeContractAsync, {
          address: poolAddress,
          abi: aavePoolAbi as any,
          functionName: 'repayWithATokens',
          args: [borrowedAsset.underlyingAsset, finalAmount, 2n],
        })
        log(`Transaction submitted! Hash: ${txHash}`)
        setStep(2)
      } catch (e: any) {
        log(`Error: ${e.message || e}`)
        setStep(0)
      }
      return
    }

    // Cross-asset: one-transaction close via the deleverager contract.
    if (!deleveragerAvailable) return
    const result = await deleverage.close({
      collateral: selectedCollateral,
      debtAsset: borrowedAsset,
      slippagePercent: slippage,
    })
    setStep(result.status === 'success' ? 2 : 0)
  }

  // Cross-asset progress comes from the hook; same-asset uses local logs.
  const shownLogs = isSameAsset ? logs : deleverage.logs
  const isProcessing = isSameAsset ? step === 1 : deleverage.step === 'running'
  const canExecute = isSameAsset
    ? !!amountStr && parseFloat(amountStr) > 0
    : deleveragerAvailable

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <h2>Close Borrow Position</h2>
        <p>
          Debt to Close:{' '}
          <strong>
            {borrowedAsset.amount.toFixed(4)} {borrowedAsset.symbol}
          </strong>
        </p>

        <div style={{ marginTop: '20px' }}>
          <label>Select Collateral to Use:</label>
          <select
            value={selectedCollateral?.underlyingAsset || ''}
            onChange={(e) =>
              setSelectedCollateral(suppliedAssets.find((a) => a.underlyingAsset === e.target.value))
            }
            style={{ display: 'block', width: '100%', padding: '10px', marginTop: '10px' }}
          >
            {suppliedAssets.map((asset, i) => (
              <option key={i} value={asset.underlyingAsset}>
                {asset.symbol} ({asset.amount.toFixed(4)} Available)
              </option>
            ))}
          </select>
        </div>

        {isSameAsset ? (
          <div style={{ marginTop: '20px' }}>
            <label style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Amount to Repay (in {borrowedAsset.symbol}):</span>
              <button
                onClick={() => {
                  setAmountStr(borrowedAsset.amount.toString())
                  setIsMax(true)
                }}
                style={{ fontSize: '10px', padding: '2px 6px', background: '#333', color: '#fff', border: 'none', borderRadius: '4px' }}
              >
                MAX
              </button>
            </label>
            <input
              type="number"
              value={amountStr}
              onChange={(e) => {
                setAmountStr(e.target.value)
                setIsMax(false)
              }}
              placeholder="0.00"
              style={{ display: 'block', width: '100%', padding: '10px', marginTop: '10px' }}
            />
          </div>
        ) : (
          <div style={{ marginTop: '20px' }}>
            <label style={{ display: 'block', marginBottom: '8px' }}>Max Slippage:</label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              {SLIPPAGE_PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => setSlippage(p)}
                  style={{
                    padding: '6px 12px',
                    border: '1px solid #333',
                    borderRadius: '6px',
                    background: slippage === p ? '#111' : 'transparent',
                    color: slippage === p ? '#fff' : 'inherit',
                    cursor: 'pointer',
                  }}
                >
                  {p}%
                </button>
              ))}
              <input
                type="number"
                step="any"
                value={slippage}
                onChange={(e) => setSlippage(Math.max(0, parseFloat(e.target.value) || 0))}
                style={{ width: '80px', padding: '6px', marginLeft: 'auto' }}
              />
              <span>%</span>
            </div>
          </div>
        )}

        <div style={{ marginTop: '20px', padding: '15px', backgroundColor: '#111', borderRadius: '8px' }}>
          <h4>Execution Path</h4>
          {isSameAsset ? (
            <p style={{ color: '#4ade80', fontSize: '14px' }}>
              ✅ Native Aave <strong>repayWithATokens</strong> (Zero Fees, 1 Transaction)
            </p>
          ) : deleveragerAvailable ? (
            <div>
              <p style={{ color: '#4ade80', fontSize: '14px' }}>
                ✅ One transaction — Uniswap V4 flash loan (best of KyberSwap / OpenOcean)
              </p>
              <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '5px' }}>
                Full close: repays all {borrowedAsset.amount.toFixed(4)} {borrowedAsset.symbol} using your{' '}
                {selectedCollateral?.symbol}. Any remainder is returned to your wallet.
              </p>
            </div>
          ) : (
            <p style={{ color: '#fbbf24', fontSize: '14px' }}>
              ⚠️ One-click close is not available on this network yet.
            </p>
          )}
        </div>

        {uiMaxFee && uiMaxPriority && (
          <div style={{ marginTop: '20px', padding: '12px', backgroundColor: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '13px', color: '#4b5563' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span>Max Fee (Estimated):</span>
              <span style={{ fontWeight: '600' }}>{Number(formatGwei(uiMaxFee)).toFixed(2)} Gwei</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Max Priority Fee:</span>
              <span style={{ fontWeight: '600' }}>{Number(formatGwei(uiMaxPriority)).toFixed(2)} Gwei</span>
            </div>
          </div>
        )}

        {shownLogs.length > 0 && (
          <div style={{ marginTop: '20px', padding: '10px', backgroundColor: '#000', color: '#0f0', fontSize: '12px', fontFamily: 'monospace', maxHeight: '150px', overflowY: 'auto' }}>
            {shownLogs.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        )}

        <div style={{ marginTop: '30px', display: 'flex', gap: '10px' }}>
          <button onClick={onClose} style={{ flex: 1, padding: '10px', backgroundColor: '#333', color: 'white', border: 'none' }}>
            Cancel
          </button>
          <button
            onClick={executeClose}
            disabled={isProcessing || !canExecute}
            style={{ flex: 1, padding: '10px', backgroundColor: '#e2e2e2', color: 'black', border: 'none', fontWeight: 'bold' }}
          >
            {isProcessing ? 'Processing…' : 'Execute'}
          </button>
        </div>
      </div>
    </div>
  )
}
