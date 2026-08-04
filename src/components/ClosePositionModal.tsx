import { useState, useEffect } from 'react'
import { useWriteContract, useConnection, useChainId, useConfig } from 'wagmi'
import { parseUnits, maxUint256, formatGwei } from 'viem'
import { getChainConfig, getDeleveragerAddress } from '../config/chains'
import { aavePoolAbi } from '../config/aavev3Abi'
import type { BorrowedAsset, SuppliedAsset } from '../hooks/useAavePositions'
import { extractRevertMessage } from '../utils/errors'
import { useAdjustedGas } from '../hooks/useAdjustedGas'

import { simulateAndWrite } from '../utils/contract'
import { ExplorerLink } from './ExplorerLink'
import { useDeleverageClose, type ClosePreview } from '../hooks/useDeleverageClose'

const SLIPPAGE_PRESETS = [0.1, 0.5, 1]

// Trim a full-precision formatUnits string to something readable in the UI.
const formatAmount = (s: string): string => {
  const n = Number(s)
  if (n === 0) return '0'
  if (n > 0 && n < 0.0001) return n.toExponential(2)
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 })
}

interface ClosePositionModalProps {
  borrowedAsset: BorrowedAsset
  suppliedAssets: SuppliedAsset[]
  onClose: () => void
}

export function ClosePositionModal({ borrowedAsset, suppliedAssets, onClose }: ClosePositionModalProps) {
  const { address } = useConnection()
  const chainId = useChainId()
  const [selectedCollateral, setSelectedCollateral] = useState<SuppliedAsset | null>(suppliedAssets[0] ?? null)
  const [amountStr, setAmountStr] = useState<string>('')
  const [isMax, setIsMax] = useState<boolean>(false)
  const [slippage, setSlippage] = useState<number>(0.5)

  const [step, setStep] = useState<number>(0)
  const [logs, setLogs] = useState<string[]>([])
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>(undefined)
  /** A close/repay has landed and the form has been reset for it. Cleared on the next attempt. */
  const [isComplete, setIsComplete] = useState<boolean>(false)

  const [preview, setPreview] = useState<ClosePreview | null>(null)
  /** Why the preview could not be produced — paused contract, empty router allowlist, etc. */
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [isQuoting, setIsQuoting] = useState<boolean>(false)
  const [refreshTick, setRefreshTick] = useState<number>(0)

  const { mutateAsync: writeContractAsync } = useWriteContract()
  const config = useConfig()
  const { preview: quotePreview, close: closePosition, logs: closeLogs, step: closeStep } = useDeleverageClose()
  const chainConfig = getChainConfig(chainId)
  const poolAddress = chainConfig?.aave?.poolAddress as `0x${string}`

  const isSameAsset =
    selectedCollateral?.underlyingAsset?.toLowerCase() === borrowedAsset.underlyingAsset.toLowerCase()
  const deleveragerAvailable = getDeleveragerAddress(chainId) !== null

  // Fetch the sized-swap preview (real router numbers) whenever the inputs change.
  // The reset is done inside the async body so we never call setState synchronously
  // in the effect (avoids cascading renders).
  useEffect(() => {
    const shouldQuote = !isSameAsset && deleveragerAvailable && !!selectedCollateral

    let isMounted = true
    const run = async () => {
      if (!shouldQuote) {
        if (isMounted) { setPreview(null); setPreviewError(null) }
        return
      }
      setIsQuoting(true)
      try {
        const p = await quotePreview({
          collateral: selectedCollateral,
          debtAsset: borrowedAsset,
          slippagePercent: slippage,
        })
        if (isMounted) { setPreview(p.preview); setPreviewError(p.error) }
      } finally {
        if (isMounted) setIsQuoting(false)
      }
    }

    // Debounce slightly if the user rapidly changes collateral or slippage.
    const timeout = setTimeout(run, 300)
    return () => {
      isMounted = false
      clearTimeout(timeout)
    }
  }, [selectedCollateral, borrowedAsset, slippage, isSameAsset, deleveragerAvailable, quotePreview, refreshTick])

  // Only estimate once there's something to act on: an entered amount for the
  // same-asset repay, or an available one-click close for the cross-asset path.
  const { maxFee: uiMaxFee, maxPriority: uiMaxPriority } = useAdjustedGas(
    300000n /* deleverage close */, 0,
    isSameAsset ? parseFloat(amountStr) > 0 : deleveragerAvailable,
  )

  const log = (msg: string) => setLogs((prev) => [...prev, msg])

  // Clear the inputs and the quote once an action lands. Without this every gate on the
  // Execute button is still satisfied afterwards — `amountStr` still holds the repaid
  // amount, `preview` still holds a quote for debt that no longer exists, and the effect
  // never re-runs because none of its deps changed — so the button re-enables and a second
  // click costs two more permit signatures before reverting on-chain. The tx hash and the
  // logs are deliberately kept: they are the record of what just happened.
  const resetForm = () => {
    setAmountStr('')
    setIsMax(false)
    setPreview(null)
    setPreviewError(null)
    setIsComplete(true)
  }

  const executeClose = async () => {
    if (!address || !selectedCollateral || !poolAddress) return

    // A hash or log lines carried over from a previous attempt would read as belonging to
    // this one. The cross-asset path's logs live in the hook, which clears them itself.
    setIsComplete(false)
    setTxHash(undefined)
    setLogs([])

    if (isSameAsset) {
      if (!amountStr) return
      try {
        setStep(1)
        const amountParsed = parseUnits(amountStr, borrowedAsset.decimals)
        const finalAmount = isMax ? maxUint256 : amountParsed
        log(`Simulating repayWithATokens for ${isMax ? 'MAX' : amountStr} ${borrowedAsset.symbol}…`)
        const hash = await simulateAndWrite(config, writeContractAsync, { chainId,
          address: poolAddress,
          abi: aavePoolAbi,
          functionName: 'repayWithATokens',
          args: [borrowedAsset.underlyingAsset, finalAmount, 2n],
        })
        setTxHash(hash)
        log(`Transaction submitted! Hash: ${hash}`)
        setStep(2)
        resetForm()
      } catch (e) {
        log(`Error: ${extractRevertMessage(e)}`)
        setStep(0)
      }
      return
    }

    // Cross-asset: one-transaction close via the deleverager contract.
    if (!deleveragerAvailable) return
    const result = await closePosition({
      collateral: selectedCollateral,
      debtAsset: borrowedAsset,
      slippagePercent: slippage,
    })
    if (result.hash) setTxHash(result.hash as `0x${string}`)
    if (result.status === 'success') {
      setStep(2)
      resetForm()
    } else {
      setStep(0)
    }
  }

  // Cross-asset progress comes from the hook; same-asset uses local logs.
  const shownLogs = isSameAsset ? logs : closeLogs
  const isProcessing = isSameAsset ? step === 1 : closeStep === 'running'
  const canExecute = isSameAsset
    ? !!amountStr && parseFloat(amountStr) > 0
    // `guaranteed` gates execution too: close() refuses a route whose guaranteed
    // output falls below the debt, so the button must not invite the click.
    : deleveragerAvailable && !isQuoting && preview?.covered === true && preview?.guaranteed === true

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <div className="modal-header">
          <h2>Close Borrow Position</h2>
        </div>

        <div className="modal-body">
          <div className="info-row" style={{ marginBottom: borrowedAsset.priceInUsd != null ? 'var(--space-2)' : 'var(--space-4)' }}>
            <span className="info-row-label">Debt to Close</span>
            <span className="info-row-value" style={{ fontSize: 'var(--text-lg)', color: 'var(--color-danger)' }}>
              {borrowedAsset.amount.toFixed(4)} {borrowedAsset.symbol}
            </span>
          </div>
          {borrowedAsset.priceInUsd != null && (
            <div className="info-row" style={{ marginBottom: 'var(--space-4)' }}>
              <span className="info-row-label">{borrowedAsset.symbol} Price</span>
              <span className="info-row-value">
                ${Number(borrowedAsset.priceInUsd).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>
                  {' · ≈ $'}
                  {(borrowedAsset.amount * Number(borrowedAsset.priceInUsd)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
              </span>
            </div>
          )}

          <div style={{ marginBottom: 'var(--space-5)' }}>
            <label style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)', fontWeight: 500 }}>
              Select Collateral to Use
            </label>
            <select
              className="input"
              value={selectedCollateral?.underlyingAsset || ''}
              onChange={(e) =>
                setSelectedCollateral(suppliedAssets.find((a) => a.underlyingAsset === e.target.value) ?? null)
              }
              style={{ appearance: 'none', backgroundImage: 'url("data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%2364748b%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px top 50%', backgroundSize: '10px auto' }}
            >
              {suppliedAssets.map((asset, i) => (
                <option key={i} value={asset.underlyingAsset}>
                  {asset.symbol} ({asset.amount.toFixed(4)} Available)
                </option>
              ))}
            </select>
          </div>

          {isSameAsset ? (
            <div style={{ marginBottom: 'var(--space-5)' }}>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)', fontWeight: 500 }}>
                <span>Amount to Repay (in {borrowedAsset.symbol})</span>
                <button
                  className="btn-ghost"
                  onClick={() => {
                    setAmountStr(borrowedAsset.amount.toFixed(borrowedAsset.decimals))
                    setIsMax(true)
                  }}
                  style={{ fontSize: 'var(--text-xs)', padding: '2px 6px', background: 'var(--color-primary)', color: 'var(--color-primary-text)', borderRadius: 'var(--radius-sm)' }}
                >
                  MAX
                </button>
              </label>
              <input
                type="number"
                className="input"
                value={amountStr}
                onChange={(e) => {
                  setAmountStr(e.target.value)
                  setIsMax(false)
                }}
                placeholder="0.00"
              />
            </div>
          ) : (
            <div style={{ marginBottom: 'var(--space-5)' }}>
              <label style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)', fontWeight: 500 }}>
                Max Slippage
              </label>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                {SLIPPAGE_PRESETS.map((p) => (
                  <button
                    key={p}
                    onClick={() => setSlippage(p)}
                    style={{
                      padding: '6px 14px',
                      border: `1px solid var(--color-border)`,
                      borderRadius: 'var(--radius-md)',
                      background: slippage === p ? 'var(--color-primary)' : 'var(--color-surface-alt)',
                      color: slippage === p ? 'var(--color-primary-text)' : 'var(--color-text)',
                      cursor: 'pointer',
                      fontWeight: slippage === p ? 600 : 400,
                      transition: 'var(--transition)'
                    }}
                  >
                    {p}%
                  </button>
                ))}
                <div style={{ position: 'relative', flex: 1, marginLeft: '8px' }}>
                  <input
                    type="number"
                    step="any"
                    className="input"
                    value={slippage}
                    onChange={(e) => setSlippage(Math.max(0, parseFloat(e.target.value) || 0))}
                    style={{ paddingRight: '24px' }}
                  />
                  <span style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', pointerEvents: 'none' }}>
                    %
                  </span>
                </div>
              </div>
            </div>
          )}

          <div className={isSameAsset || deleveragerAvailable ? "alert alert-success" : "alert alert-warning"} style={{ marginBottom: 'var(--space-5)' }}>
            <h4 style={{ margin: '0 0 8px 0', fontSize: 'var(--text-sm)', color: 'inherit' }}>Execution Path</h4>
            {isSameAsset ? (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                <span>✅</span>
                <span style={{ fontSize: 'var(--text-sm)' }}>Native Aave <strong>repayWithATokens</strong> (Zero Fees, 1 Transaction)</span>
              </div>
            ) : deleveragerAvailable ? (
              <div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                  {isQuoting ? <span>⏳</span> : <span>✅</span>}
                  <span style={{ fontSize: 'var(--text-sm)' }}>
                    One transaction — Morpho Blue zero-fee flash loan{' '}
                    {preview ? <strong>(via {preview.aggregator})</strong> : isQuoting ? <span style={{ opacity: 0.7 }}>(Finding best route...)</span> : ''}
                  </span>
                </div>
                <p style={{ fontSize: 'var(--text-xs)', marginTop: '8px', marginBottom: 0, opacity: 0.85, lineHeight: 1.4 }}>
                  Swaps only enough {selectedCollateral?.symbol} to repay {borrowedAsset.amount.toFixed(4)} {borrowedAsset.symbol}. Nothing is requested until you press Execute — then your wallet asks for{' '}
                  <strong>two signatures and one transaction</strong>.
                </p>
                {/*
                  The second signature is the one users do not expect, and an unexplained
                  extra prompt reads as a phishing attempt. Spell out what it does: it is a
                  permit for zero, consumed in the same transaction, so the approval the
                  first signature grants cannot outlive the close.
                */}
                <p style={{ fontSize: 'var(--text-xs)', marginTop: '6px', marginBottom: 0, opacity: 0.75, lineHeight: 1.4 }}>
                  The first signature approves your a{selectedCollateral?.symbol}; the second revokes it
                  again in the same transaction, so no spending allowance is left behind afterwards.
                  Both are free — only the transaction costs gas.
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span>⚠️</span>
                <span style={{ fontSize: 'var(--text-sm)' }}>One-click close is not available on this network yet.</span>
              </div>
            )}
          </div>

          {/*
            Once the action has landed the quote has been cleared, and an empty quote panel
            renders as "no swap route available" — which reads as a failure directly under a
            successful transaction. Show what actually happened instead.
          */}
          {isComplete && (
            <div className="alert alert-success" style={{ marginBottom: 'var(--space-5)' }}>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                <span>✅</span>
                <span style={{ fontSize: 'var(--text-sm)' }}>
                  {isSameAsset
                    ? `Repayment submitted. Your ${borrowedAsset.symbol} position will update once it confirms.`
                    : `Position closed. Your ${borrowedAsset.symbol} debt is repaid and the unswapped ${selectedCollateral?.symbol} stays supplied in Aave.`}
                </span>
              </div>
            </div>
          )}

          {!isSameAsset && deleveragerAvailable && !isComplete && (
            <div style={{ marginBottom: 'var(--space-5)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h4 style={{ margin: 0, fontSize: 'var(--text-sm)' }}>Estimated Output</h4>
                <button
                  onClick={() => setRefreshTick((t) => t + 1)}
                  disabled={isQuoting}
                  className="btn-ghost"
                  title="Re-fetch the latest quote and prices"
                  style={{ fontSize: 'var(--text-xs)', padding: '3px 8px', display: 'flex', alignItems: 'center', gap: '4px', cursor: isQuoting ? 'default' : 'pointer', opacity: isQuoting ? 0.6 : 1 }}
                >
                  <span>↻</span> {isQuoting ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>
              {preview && preview.covered ? (
                <div style={{ padding: '14px', backgroundColor: 'var(--color-surface-alt)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
                  <div className="info-row">
                    <span className="info-row-label">Collateral in (to swap)</span>
                    <span className="info-row-value">{formatAmount(preview.collateralSwapped)} {preview.collateralSymbol}</span>
                  </div>
                  <div className="info-row">
                    <span className="info-row-label">Debt to repay</span>
                    <span className="info-row-value">{formatAmount(preview.debtRepaid)} {preview.debtSymbol}</span>
                  </div>
                  <div className="info-row">
                    <span className="info-row-label">Min debt out (router)</span>
                    <span className="info-row-value" style={{ color: preview.guaranteed ? 'var(--color-success)' : 'var(--color-danger)' }}>
                      {formatAmount(preview.minDebtOut)} {preview.debtSymbol}
                    </span>
                  </div>
                  <div className="info-row">
                    <span className="info-row-label" style={{ fontWeight: 600 }}>Stays supplied in Aave (est.)</span>
                    <span className="info-row-value" style={{ color: 'var(--color-success)', fontWeight: 600 }}>
                      {formatAmount(preview.collateralKeptSupplied)} {preview.collateralSymbol}
                      {preview.collateralKeptSuppliedUsd != null ? ` (~$${preview.collateralKeptSuppliedUsd.toFixed(2)})` : ''}
                    </span>
                  </div>
                  <div className="info-row">
                    <span className="info-row-label">Route</span>
                    <span className="info-row-value">{preview.aggregator}</span>
                  </div>
                  {!preview.guaranteed && (
                    <div style={{ marginTop: '10px', fontSize: 'var(--text-xs)', color: 'var(--color-danger)', lineHeight: 1.4 }}>
                      ⚠️ At {slippage}% slippage the router only guarantees {formatAmount(preview.minDebtOut)} {preview.debtSymbol}, below your {formatAmount(preview.debtRepaid)} {preview.debtSymbol} debt. Closing is blocked so you don't sign for a swap that would revert on-chain — lower the slippage to guarantee it.
                    </div>
                  )}
                  <p style={{ fontSize: 'var(--text-xs)', marginTop: '10px', marginBottom: 0, opacity: 0.7, lineHeight: 1.4 }}>
                    Only enough {preview.collateralSymbol} is swapped for the router's guaranteed output to repay the debt at {slippage}% slippage; the rest stays supplied in Aave. Estimated from your live balances.
                  </p>
                </div>
              ) : preview && !preview.covered ? (
                <div className="alert alert-warning" style={{ margin: 0 }}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                    <span>⚠️</span>
                    <span style={{ fontSize: 'var(--text-sm)' }}>
                      Collateral won’t cover the debt — the position is underwater. Try a different collateral.
                    </span>
                  </div>
                </div>
              ) : isQuoting ? (
                <div style={{ padding: '14px', backgroundColor: 'var(--color-surface-alt)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                  Calculating your output…
                </div>
              ) : previewError ? (
                // A deployment-level problem (paused, empty router allowlist, unsupported
                // network) is not fixable by picking different collateral, so it must not
                // render as "no route for this pair" — that sends users round in circles.
                <div className="alert alert-warning" style={{ margin: 0 }}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                    <span>⚠️</span>
                    <span style={{ fontSize: 'var(--text-sm)' }}>{previewError}</span>
                  </div>
                </div>
              ) : (
                <div style={{ padding: '14px', backgroundColor: 'var(--color-surface-alt)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                  No swap route available for this pair right now.
                </div>
              )}
            </div>
          )}

          {uiMaxFee && uiMaxPriority && (
            <div style={{ padding: '12px', backgroundColor: 'var(--color-surface-alt)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
              <div className="info-row">
                <span className="info-row-label">Max Fee (Estimated)</span>
                <span className="info-row-value">{Number(formatGwei(uiMaxFee)).toFixed(2)} Gwei</span>
              </div>
              <div className="info-row">
                <span className="info-row-label">Max Priority Fee</span>
                <span className="info-row-value">{Number(formatGwei(uiMaxPriority)).toFixed(2)} Gwei</span>
              </div>
            </div>
          )}

          {shownLogs.length > 0 && (
            <div style={{ marginTop: 'var(--space-5)', padding: '12px', backgroundColor: 'var(--color-surface-alt)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)', borderRadius: 'var(--radius-md)', fontSize: '12px', fontFamily: 'var(--font-mono)', maxHeight: '150px', overflowY: 'auto' }}>
              {shownLogs.map((l, i) => (
                <div key={i} style={{ marginBottom: '4px' }}>{l}</div>
              ))}
            </div>
          )}

          {txHash && (
            <div style={{ marginTop: 'var(--space-5)' }}>
              <ExplorerLink hash={txHash} chainId={chainId} />
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary" style={{ flex: 1, padding: '10px' }}>
            {isComplete ? 'Done' : 'Cancel'}
          </button>
          <button
            onClick={executeClose}
            disabled={isProcessing || !canExecute}
            className="btn-primary"
            style={{ flex: 1, padding: '10px' }}
          >
            {isProcessing ? 'Processing…' : 'Execute Close'}
          </button>
        </div>
      </div>
    </div>
  )
}
