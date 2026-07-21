import { useState, useEffect } from 'react'
import { useAavePositions } from '../hooks/useAavePositions'
import { exitViewMode } from '../hooks/useViewMode'
import { ClosePositionModal } from './ClosePositionModal'
import { WithdrawModal } from './WithdrawModal'
import { AssetsToSupplyModal } from './AssetsToSupplyModal'
import { AssetsToBorrowModal } from './AssetsToBorrowModal'
import { BorrowRepayModal } from './BorrowRepayModal'
import { T, modalStyle, labelStyle, inputStyle } from '../styles/theme'
import { getChainConfig } from '../config/chains'

const AVG_PRICE_OVERRIDE_STORAGE_KEY = 'aave.avgPriceOverrides.v1'

interface AavePositionProps {
  viewAddress?: `0x${string}`
  viewChainId?: number
  apiEthPrice?: number | null
}

export function AavePosition({ viewAddress, viewChainId, apiEthPrice }: AavePositionProps = {}) {
  const {
    isConnected,
    isViewMode,
    viewedAddress,
    isLoading,
    collateralUsd,
    debtUsd,
    availableBorrowsUsd,
    ltvPercent,
    liquidationThreshold,
    formattedHealthFactor,
    netApy,
    totalInterestEarnedUsd,
    totalInterestPaidUsd,
    suppliedAssets,
    borrowedAssets,
    availableReserves,
    chainId
  } = useAavePositions({ viewAddress, viewChainId })

  const [closeTarget, setCloseTarget] = useState<Record<string, unknown> | null>(null)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [withdrawTarget, setWithdrawTarget] = useState<{ asset: any } | null>(null)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [borrowRepayTarget, setBorrowRepayTarget] = useState<{ asset: any, tab: 'borrow' | 'repay' } | null>(null)
  const [isAssetsToSupplyModalOpen, setIsAssetsToSupplyModalOpen] = useState(false)
  const [isAssetsToBorrowModalOpen, setIsAssetsToBorrowModalOpen] = useState(false)

  const fmtSigned = (n: number) => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`

  // User-supplied avg-buy-price overrides, keyed by lowercased underlying-asset address.
  // Persisted to localStorage so overrides survive reload.
  const [overrides, setOverrides] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem(AVG_PRICE_OVERRIDE_STORAGE_KEY)
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(AVG_PRICE_OVERRIDE_STORAGE_KEY, JSON.stringify(overrides))
    } catch {
      /* ignore quota */
    }
  }, [overrides])

  // Track which row currently has its override input open.
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [draftValue, setDraftValue] = useState<string>('')

  const openEditor = (key: string, currentValue: number) => {
    setEditingKey(key)
    setDraftValue(currentValue > 0 ? currentValue.toFixed(4) : '')
  }
  const saveDraft = (key: string) => {
    const v = parseFloat(draftValue)
    setOverrides(prev => {
      const next = { ...prev }
      if (isFinite(v) && v > 0) next[key] = v
      else delete next[key]
      return next
    })
    setEditingKey(null)
  }
  const cancelDraft = () => setEditingKey(null)

  /**
   * Recompute the row's P&L breakdown, applying an avg-entry override if the user
   * has provided one. `side` is 'supply' for lenders and 'borrow' for borrowers —
   * price gain is signed opposite for the two sides.
   */
  const applyOverride = (
    a: { positionPnl?: { avgEntryPriceUsd: number; realizedPnlUsd: number; interestUsd: number }; amount: number; interestEarnedTokens?: number; interestPaidTokens?: number; priceInUsd: string; underlyingAsset: string },
    side: 'supply' | 'borrow'
  ) => {
    const pnl = a.positionPnl
    if (!pnl) return null
    // Overrides are keyed by side:address so a WETH supply override doesn't leak into a WETH borrow.
    const overrideKey = `${side}:${a.underlyingAsset.toLowerCase()}`
    const override = overrides[overrideKey]
    const effectiveAvgEntry = override && override > 0 ? override : pnl.avgEntryPriceUsd
    if (!(effectiveAvgEntry > 0)) return { effectiveAvgEntry: 0, priceGainUsd: 0, totalPnlUsd: 0, isOverride: false }

    const chainConfig = getChainConfig(chainId)
    const nativeWrappedSymbol = chainConfig?.defaultTokens?.[0]?.symbol?.toUpperCase() || 'WETH'
    const isNativeToken = a.symbol.toUpperCase() === nativeWrappedSymbol
    const currentPrice = (isNativeToken && apiEthPrice) ? apiEthPrice : Number(a.priceInUsd)

    // For lenders: netPrincipal = balance - interestEarned; supply P&L uses netPrincipal for price and interestTokens at current price.
    // For borrowers: same shape but sign flipped and interest treated as cost.
    const interestTokens = side === 'supply' ? (a.interestEarnedTokens ?? 0) : (a.interestPaidTokens ?? 0)
    const netPrincipal = Math.max(0, a.amount - interestTokens)
    const priceDelta = side === 'supply' ? currentPrice - effectiveAvgEntry : effectiveAvgEntry - currentPrice
    const priceGainUsd = priceDelta * netPrincipal
    const interestUsd = pnl.interestUsd // signed: positive for supply, negative for borrow
    const totalPnlUsd = pnl.realizedPnlUsd + priceGainUsd + interestUsd

    return {
      effectiveAvgEntry,
      priceGainUsd,
      interestUsd,
      realizedPnlUsd: pnl.realizedPnlUsd,
      totalPnlUsd,
      isOverride: !!override,
    }
  }

  // Sum P&L using effective (possibly-overridden) entries so the top KPI matches the rows.
  const effectiveTotalPnlUsd = [
    ...suppliedAssets.map(a => ({ a, side: 'supply' as const })),
    ...borrowedAssets.map(a => ({ a, side: 'borrow' as const })),
  ].reduce((sum, { a, side }) => {
    const r = applyOverride(a, side)
    return sum + (r?.totalPnlUsd ?? 0)
  }, 0)

  /** Value(USD) cell — shows just the value + a clickable Avg row that opens the editor modal. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ValueCell = ({ a, side, r }: { a: any; side: 'supply' | 'borrow'; r: ReturnType<typeof applyOverride> }) => {
    const rowKey = `${side}:${a.underlyingAsset.toLowerCase()}`
    const effectiveAvgEntry = r?.effectiveAvgEntry ?? 0
    const isOverride = !!r?.isOverride
    const chainConfig = getChainConfig(chainId)
    const nativeWrappedSymbol = chainConfig?.defaultTokens?.[0]?.symbol?.toUpperCase() || 'WETH'
    const isNativeToken = a.symbol.toUpperCase() === nativeWrappedSymbol
    const currentPrice = (isNativeToken && apiEthPrice) ? apiEthPrice : Number(a.priceInUsd)
    const valueUsd = a.amount * currentPrice

    return (
      <td className="number" data-label="Value (USD)">
        ${valueUsd.toFixed(2)}
        <div style={{ fontSize: T.fontSize.xs, color: T.textMuted, marginTop: '2px' }}>
          @ ${currentPrice.toFixed(2)}
        </div>
        <div style={{ fontSize: T.fontSize.xs, color: T.textMuted, marginTop: '4px' }}>
          <button
            type="button"
            onClick={() => openEditor(rowKey, effectiveAvgEntry)}
            title={side === 'supply' ? 'Click to set your own avg buy price' : 'Click to set your own avg borrow price'}
            className="btn-ghost"
            style={{
              padding: '2px 4px',
              color: isOverride ? T.primary : 'inherit',
              fontSize: '0.75rem',
              textDecoration: 'underline dotted',
              textUnderlineOffset: '2px',
            }}
          >
            Avg: {effectiveAvgEntry > 0 ? `$${effectiveAvgEntry.toFixed(2)}` : '—'}
          </button>
        </div>
      </td>
    )
  }

  /**
   * Look up the asset behind the currently-open editor key, so the modal can pull
   * on-chain avg, current price, symbol, etc. Returns null if the key doesn't match anything.
   */
  const getEditContext = () => {
    if (!editingKey) return null
    const [side, addr] = editingKey.split(':') as ['supply' | 'borrow', string]
    const list = side === 'supply' ? suppliedAssets : borrowedAssets
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    const asset = list.find((a: any) => a.underlyingAsset.toLowerCase() === addr)
    if (!asset) return null
    const chainConfig = getChainConfig(chainId)
    const nativeWrappedSymbol = chainConfig?.defaultTokens?.[0]?.symbol?.toUpperCase() || 'WETH'
    const isNativeToken = asset.symbol.toUpperCase() === nativeWrappedSymbol
    const currentPrice = (isNativeToken && apiEthPrice) ? apiEthPrice : Number(asset.priceInUsd)

    return {
      side,
      asset,
      rowKey: editingKey,
      onChainAvg: asset.positionPnl?.avgEntryPriceUsd ?? 0,
      currentPrice,
      isOverride: editingKey in overrides,
    }
  }
  const editCtx = getEditContext()

  const resetOverride = (rowKey: string) => {
    setOverrides(prev => {
      const n = { ...prev }
      delete n[rowKey]
      return n
    })
    setEditingKey(null)
  }

  /** P&L cell with breakdown on separate lines. Shared by both tables. */
  const PnlCell = ({ r, side }: { r: ReturnType<typeof applyOverride>; side: 'supply' | 'borrow' }) => {
    if (!r || r.effectiveAvgEntry <= 0) {
      return <td className="number" data-label="Position P&L"><span style={{ color: T.textMuted }}>—</span></td>
    }
    const yieldLabel = side === 'supply' ? 'Yield' : 'Cost'
    return (
      <td className="number" data-label="Position P&L">
        <div className={r.totalPnlUsd >= 0 ? 'text-success' : 'text-danger'}>
          {fmtSigned(r.totalPnlUsd)}
        </div>
        <div style={{ fontSize: '0.75rem', color: T.textMuted, lineHeight: 1.4 }}>
          <div>Price {fmtSigned(r.priceGainUsd)}</div>
          <div>{yieldLabel} {fmtSigned(r.interestUsd ?? 0)}</div>
          {r.realizedPnlUsd !== undefined && r.realizedPnlUsd !== 0 && (
            <div>Realized {fmtSigned(r.realizedPnlUsd)}</div>
          )}
        </div>
      </td>
    )
  }

  const renderViewModeBanner = () => {
    if (!isViewMode || !viewedAddress) return null;
    return (
      <div className="view-mode-banner">
        <span>Viewing positions for {viewedAddress}</span>
        <button
          onClick={() => exitViewMode()}
          className="exit-view-btn"
        >
          Exit View Mode
        </button>
      </div>
    )
  }

  if (!isConnected) return null
  if (isLoading) return <div>Loading Aave Position...</div>
  if (suppliedAssets.length === 0 && borrowedAssets.length === 0 && collateralUsd === 0) {
    // Read-only view of someone else's wallet: nothing to act on.
    if (isViewMode) {
      return (
        <div className="dashboard-container">
          {renderViewModeBanner()}
          <div>No Aave data found for this address.</div>
        </div>
      )
    }
    // Connected wallet with no position yet: let them open one.
    const chainConfig = getChainConfig(chainId)
    const nativeWrappedSymbol = chainConfig?.defaultTokens?.[0]?.symbol?.toUpperCase() || 'WETH'
    const emptyEthPriceUsd = Number(availableReserves?.find((r: { symbol: string; priceInUsd?: string | number | null }) => r.symbol.toUpperCase() === nativeWrappedSymbol)?.priceInUsd || 0)
    return (
      <div className="dashboard-container">
        <div className="card" style={{ textAlign: 'center', padding: T.space[8] }}>
          <h2 style={{ fontSize: T.fontSize.xl, margin: `0 0 ${T.space[2]}` }}>Start your Aave position</h2>
          <p className="text-muted" style={{ margin: `0 auto ${T.space[5]}`, maxWidth: '420px' }}>
            You don't have any supplied or borrowed assets yet. Supply collateral to start earning — you'll need collateral before you can borrow.
          </p>
          <div style={{ display: 'flex', gap: T.space[3], justifyContent: 'center' }}>
            <button className="btn-primary" onClick={() => setIsAssetsToSupplyModalOpen(true)}>Supply</button>
            <button 
              className="btn-secondary" 
              onClick={() => setIsAssetsToBorrowModalOpen(true)}
              disabled={true}
              title="You must supply collateral first to borrow"
              style={{ opacity: 0.6, cursor: 'not-allowed' }}
            >
              Borrow
            </button>
          </div>
        </div>

        {isAssetsToSupplyModalOpen && (
          <AssetsToSupplyModal
            chainId={chainId}
            availableReserves={availableReserves}
            ethPriceUsd={emptyEthPriceUsd}
            collateralUsd={collateralUsd}
            debtUsd={debtUsd}
            liquidationThreshold={liquidationThreshold}
            onClose={() => setIsAssetsToSupplyModalOpen(false)}
          />
        )}
        {isAssetsToBorrowModalOpen && (
          <AssetsToBorrowModal
            chainId={chainId}
            availableReserves={availableReserves}
            ethPriceUsd={emptyEthPriceUsd}
            availableBorrowsUsd={availableBorrowsUsd}
            collateralUsd={collateralUsd}
            debtUsd={debtUsd}
            liquidationThreshold={liquidationThreshold}
            onClose={() => setIsAssetsToBorrowModalOpen(false)}
          />
        )}
      </div>
    )
  }

  const netInterestUsd = totalInterestEarnedUsd - totalInterestPaidUsd
  const chainConfig = getChainConfig(chainId)
  const nativeWrappedSymbol = chainConfig?.defaultTokens?.[0]?.symbol?.toUpperCase() || 'WETH'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ethPriceUsd = Number(availableReserves?.find((r: any) => r.symbol.toUpperCase() === nativeWrappedSymbol)?.priceInUsd || 0)

  return (
    <div className="dashboard-container">
      {renderViewModeBanner()}

      <div className="card">
        <div className="header">
          <h1>Aave V3 Portfolio</h1>
        </div>

        <div className="stats-grid">
          <div className="stat">
            <label>Net Worth</label>
            <div>${(collateralUsd - debtUsd).toFixed(2)}</div>
          </div>
          <div className="stat">
            <label>Net APY</label>
            <div className={netApy >= 0 ? 'text-success' : 'text-danger'}>
              {netApy.toFixed(2)}%
            </div>
          </div>
          <div className="stat">
            <label>Net Interest (Till Date)</label>
            <div className={netInterestUsd >= 0 ? 'text-success' : 'text-danger'}>
              {fmtSigned(netInterestUsd)}
            </div>
          </div>
          <div className="stat" title="Unrealized price P&L on open positions + realized P&L from partial exits + net interest. Uses your override avg price where set.">
            <label>Position P&amp;L</label>
            <div className={effectiveTotalPnlUsd >= 0 ? 'text-success' : 'text-danger'}>
              {fmtSigned(effectiveTotalPnlUsd)}
            </div>
          </div>
          <div className="stat">
            <label>Health Factor</label>
            <div>{formattedHealthFactor === '∞' ? '∞' : Number(formattedHealthFactor).toFixed(2)}</div>
          </div>
          <div className="stat">
            <label>Total Supplied</label>
            <div>${collateralUsd.toFixed(2)}</div>
          </div>
          <div className="stat">
            <label>Total Borrowed</label>
            <div>${debtUsd.toFixed(2)}</div>
          </div>
          <div className="stat">
            <label>Avg. LTV</label>
            <div>{ltvPercent.toFixed(2)}%</div>
          </div>
        </div>
      </div>

      <div className="asset-tables">
        <div className="card">
          <div className="header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: T.space[4], paddingBottom: T.space[3] }}>
            <h2 style={{ fontSize: T.fontSize.lg, margin: 0 }}>Supplied Assets</h2>
            {!isViewMode && (
              <button
                className="btn-primary"
                onClick={() => setIsAssetsToSupplyModalOpen(true)}
              >
                Supply
              </button>
            )}
          </div>
          {suppliedAssets.length === 0 ? (
            <p className="text-muted">No assets supplied.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Balance</th>
                    <th>Value (USD)</th>
                    <th>APY</th>
                    <th>Interest Earned</th>
                    <th>Position P&amp;L</th>
                    {!isViewMode && <th style={{ textAlign: 'right' }}>Actions</th>}
                  </tr>
                </thead>
                <tbody>
{/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  {suppliedAssets.map((a: any, i: number) => {
                    const r = applyOverride(a, 'supply');

                    return (
                      <tr key={i}>
                        <td style={{ fontWeight: 600 }}>{a.symbol}</td>
                        <td className="number" data-label="Balance">{a.amount.toFixed(4)}</td>
                        <ValueCell a={a} side="supply" r={r} />
                        <td className="number text-success" data-label="APY">{a.apy.toFixed(2)}%</td>
                        <td className="number text-success" data-label="Interest Earned">
                          {a.interestEarnedTokens.toFixed(4)} {a.symbol} <br />
                          <span style={{ fontSize: T.fontSize.xs, color: T.textMuted }}>
                            +${a.interestEarnedUsd.toFixed(2)}
                          </span>
                        </td>
                        <PnlCell r={r} side="supply" />
                        {!isViewMode && (
                          <td data-label="Actions">
                            <div style={{ display: 'flex', gap: T.space[2], alignItems: 'center', justifyContent: 'flex-end' }}>
                              <button
                                onClick={() => setWithdrawTarget({ asset: a })}
                                className="btn-secondary"
                                style={{ padding: '6px 16px', fontSize: T.fontSize.sm, fontWeight: 600 }}
                              >
                                Withdraw
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: T.space[4], paddingBottom: T.space[3] }}>
            <h2 style={{ fontSize: T.fontSize.lg, margin: 0 }}>Borrowed Assets</h2>
            {!isViewMode && (
              <button
                className="btn-primary"
                onClick={() => setIsAssetsToBorrowModalOpen(true)}
                disabled={suppliedAssets.length === 0}
                title={suppliedAssets.length === 0 ? "You must supply collateral first to borrow" : undefined}
                style={suppliedAssets.length === 0 ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}
              >
                Borrow
              </button>
            )}
          </div>
          {borrowedAssets.length === 0 ? (
            <p className="text-muted">No assets borrowed.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Balance</th>
                    <th>Value (USD)</th>
                    <th>APY</th>
                    <th>Liquidation Price</th>
                    <th>Interest Paid</th>
                    <th>Position P&amp;L</th>
                    {!isViewMode && <th style={{ textAlign: 'right' }}>Actions</th>}
                  </tr>
                </thead>
                <tbody>
{/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  {borrowedAssets.map((a: any, i: number) => {
                    const r = applyOverride(a, 'borrow');
                    // Liquidation for a borrowed (debt) asset: the price it would have to RISE
                    // to for the growing debt to push HF to 1, holding collateral and other
                    // debts fixed. Mirror of the collateral-side formula.
                    const otherDebtUsd = debtUsd - a.valueUsd;
                    const allowedThisDebtUsd = collateralUsd * liquidationThreshold - otherDebtUsd;
                    const liquidationPrice = a.amount > 0 && allowedThisDebtUsd > 0 ? allowedThisDebtUsd / a.amount : 0;
                    return (
                      <tr key={i}>
                        <td style={{ fontWeight: 600 }}>{a.symbol}</td>
                        <td className="number" data-label="Balance">{a.amount.toFixed(4)}</td>
                        <ValueCell a={a} side="borrow" r={r} />
                        <td className="number text-danger" data-label="APY">{a.apy.toFixed(2)}%</td>
                        <td className="number" data-label="Liquidation Price">{liquidationPrice > 0 ? `$${liquidationPrice.toFixed(2)}` : 'At risk'}</td>
                        <td className="number text-danger" data-label="Interest Paid">
                          {a.interestPaidTokens.toFixed(4)} {a.symbol} <br />
                          <span style={{ fontSize: T.fontSize.xs, color: T.textMuted }}>
                            -${a.interestPaidUsd.toFixed(2)}
                          </span>
                        </td>
                        <PnlCell r={r} side="borrow" />
                        {!isViewMode && (
                          <td data-label="Actions">
                            <div style={{ display: 'flex', gap: T.space[2], alignItems: 'center', justifyContent: 'flex-end' }}>
                              <button
                                onClick={() => setBorrowRepayTarget({ asset: a, tab: 'repay' })}
                                className="btn-secondary"
                                style={{ padding: '6px 12px', fontSize: T.fontSize.sm, fontWeight: 600 }}
                              >
                                Repay
                              </button>
                              <button
                                onClick={() => setCloseTarget(a)}
                                className="btn-primary"
                                style={{ padding: '6px 12px', fontSize: T.fontSize.sm, fontWeight: 600, background: T.text, borderColor: T.text }}
                              >
                                Close
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {editCtx && (
        <div className="modal-overlay" onClick={cancelDraft}>
          <div style={{ ...modalStyle, maxWidth: '360px', padding: T.space[5] }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 4px', fontSize: T.fontSize.lg }}>
              Set avg {editCtx.side === 'supply' ? 'buy' : 'borrow'} price
            </h3>
            <div style={{ fontSize: T.fontSize.sm, color: T.textMuted, marginBottom: T.space[4] }}>
              {editCtx.asset.symbol} · {editCtx.side}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: T.space[2], fontSize: T.fontSize.sm, marginBottom: T.space[4] }}>
              <div className="info-row">
                <span className="info-row-label">Current price</span>
                <span className="info-row-value">${editCtx.currentPrice.toFixed(4)}</span>
              </div>
              <div className="info-row">
                <span className="info-row-label">On-chain avg (from tx history)</span>
                <span className="info-row-value">${editCtx.onChainAvg.toFixed(4)}</span>
              </div>
              {editCtx.isOverride && (
                <div className="info-row" style={{ color: T.primary }}>
                  <span>Your current override</span>
                  <span style={{ fontWeight: 600 }}>${(overrides[editCtx.rowKey] ?? 0).toFixed(4)}</span>
                </div>
              )}
            </div>

            <label style={labelStyle}>
              Your avg price (USD)
            </label>
            <input
              type="number" step="any" value={draftValue} autoFocus
              onChange={e => setDraftValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') saveDraft(editCtx.rowKey)
                if (e.key === 'Escape') cancelDraft()
              }}
              placeholder={editCtx.onChainAvg > 0 ? editCtx.onChainAvg.toFixed(4) : '0.00'}
              style={inputStyle}
            />

            <div style={{ display: 'flex', gap: T.space[2], marginTop: T.space[5], justifyContent: 'flex-end' }}>
              {editCtx.isOverride && (
                <button
                  onClick={() => resetOverride(editCtx.rowKey)}
                  style={{ marginRight: 'auto', padding: '8px 14px', fontSize: T.fontSize.sm, background: T.dangerBg, color: T.danger, border: `1px solid ${T.dangerBorder}`, borderRadius: T.radius.md, cursor: 'pointer' }}
                >
                  Reset to on-chain
                </button>
              )}
              <button
                className="btn-secondary"
                onClick={cancelDraft}
                style={{ padding: '8px 14px', fontSize: T.fontSize.sm }}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={() => saveDraft(editCtx.rowKey)}
                style={{ padding: '8px 14px', fontSize: T.fontSize.sm }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {withdrawTarget && (
        <WithdrawModal
          asset={withdrawTarget.asset}
          ethPriceUsd={ethPriceUsd}
          collateralUsd={collateralUsd}
          debtUsd={debtUsd}
          liquidationThreshold={liquidationThreshold}
          availableReserves={availableReserves}
          onClose={() => setWithdrawTarget(null)}
        />
      )}

      {isAssetsToSupplyModalOpen && (
        <AssetsToSupplyModal
          chainId={chainId}
          availableReserves={availableReserves}
          ethPriceUsd={ethPriceUsd}
          collateralUsd={collateralUsd}
          debtUsd={debtUsd}
          liquidationThreshold={liquidationThreshold}
          onClose={() => setIsAssetsToSupplyModalOpen(false)}
        />
      )}

      {isAssetsToBorrowModalOpen && (
        <AssetsToBorrowModal
          chainId={chainId}
          availableReserves={availableReserves}
          ethPriceUsd={ethPriceUsd}
          availableBorrowsUsd={availableBorrowsUsd}
          collateralUsd={collateralUsd}
          debtUsd={debtUsd}
          liquidationThreshold={liquidationThreshold}
          onClose={() => setIsAssetsToBorrowModalOpen(false)}
        />
      )}

      {borrowRepayTarget && (
        <BorrowRepayModal
          asset={borrowRepayTarget.asset}
          initialTab={borrowRepayTarget.tab}
          ethPriceUsd={ethPriceUsd}
          collateralUsd={collateralUsd}
          debtUsd={debtUsd}
          liquidationThreshold={liquidationThreshold}
          onClose={() => setBorrowRepayTarget(null)}
        />
      )}

      {closeTarget && (
        <ClosePositionModal
          borrowedAsset={closeTarget}
          suppliedAssets={suppliedAssets}
          onClose={() => setCloseTarget(null)}
        />
      )}
    </div>
  )
}
