import { useState, useEffect } from 'react'
import { useAavePositions } from '../hooks/useAavePositions'
import { exitViewMode } from '../hooks/useViewMode'

const AVG_PRICE_OVERRIDE_STORAGE_KEY = 'aave.avgPriceOverrides.v1'

interface AavePositionProps {
  viewAddress?: `0x${string}`
  viewChainId?: number
}

export function AavePosition({ viewAddress, viewChainId }: AavePositionProps = {}) {
  const {
    isConnected,
    isViewMode,
    viewedAddress,
    isLoading,
    collateralUsd,
    debtUsd,
    ltvPercent,
    liquidationThreshold,
    formattedHealthFactor,
    netApy,
    totalInterestEarnedUsd,
    totalInterestPaidUsd,
    suppliedAssets,
    borrowedAssets
  } = useAavePositions({ viewAddress, viewChainId })

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

    const currentPrice = Number(a.priceInUsd)
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
  const ValueCell = ({ a, side, r }: { a: any; side: 'supply' | 'borrow'; r: ReturnType<typeof applyOverride> }) => {
    const rowKey = `${side}:${a.underlyingAsset.toLowerCase()}`
    const effectiveAvgEntry = r?.effectiveAvgEntry ?? 0
    const isOverride = !!r?.isOverride
    return (
      <td className="number" data-label="Value (USD)">
        ${a.valueUsd.toFixed(2)}
        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
          @ ${Number(a.priceInUsd).toFixed(2)}
        </div>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
          <button
            type="button"
            onClick={() => openEditor(rowKey, effectiveAvgEntry)}
            title={side === 'supply' ? 'Click to set your own avg buy price' : 'Click to set your own avg borrow price'}
            style={{
              background: 'transparent',
              border: 'none',
              padding: '2px 4px',
              cursor: 'pointer',
              color: isOverride ? '#2563eb' : 'inherit',
              fontSize: '0.75rem',
              textDecoration: 'underline dotted',
              textUnderlineOffset: '2px',
              fontFamily: 'inherit',
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
    const asset = list.find((a: any) => a.underlyingAsset.toLowerCase() === addr)
    if (!asset) return null
    return {
      side,
      asset,
      rowKey: editingKey,
      onChainAvg: asset.positionPnl?.avgEntryPriceUsd ?? 0,
      currentPrice: Number(asset.priceInUsd),
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
      return <td className="number" data-label="Position P&L"><span style={{ color: 'var(--text-secondary)' }}>—</span></td>
    }
    const yieldLabel = side === 'supply' ? 'Yield' : 'Cost'
    return (
      <td className="number" data-label="Position P&L">
        <div className={r.totalPnlUsd >= 0 ? 'text-success' : 'text-danger'}>
          {fmtSigned(r.totalPnlUsd)}
        </div>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
          <div>Price {fmtSigned(r.priceGainUsd)}</div>
          <div>{yieldLabel} {fmtSigned(r.interestUsd ?? 0)}</div>
          {r.realizedPnlUsd !== undefined && r.realizedPnlUsd !== 0 && (
            <div>Realized {fmtSigned(r.realizedPnlUsd)}</div>
          )}
        </div>
      </td>
    )
  }

  if (!isConnected) return null
  if (isLoading) return <div>Loading Aave Position...</div>
  if (suppliedAssets.length === 0 && borrowedAssets.length === 0 && collateralUsd === 0) {
    return (
      <div className="dashboard-container">
        {isViewMode && viewedAddress && (
          <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '14px', color: '#1e40af' }}>
              Viewing <code style={{ background: '#dbeafe', padding: '2px 6px', borderRadius: '4px', fontSize: '13px' }}>{viewedAddress.slice(0, 6)}…{viewedAddress.slice(-4)}</code> (read-only)
            </span>
            <button onClick={exitViewMode} style={{ fontSize: '13px', padding: '6px 12px', border: '1px solid #93c5fd', background: '#fff', color: '#1e40af', borderRadius: '6px', cursor: 'pointer', fontWeight: 500 }}>
              Exit view mode
            </button>
          </div>
        )}
        <div>No Aave data found for this address.</div>
      </div>
    )
  }

  const netInterestUsd = totalInterestEarnedUsd - totalInterestPaidUsd

  return (
    <div className="dashboard-container">
      {isViewMode && viewedAddress && (
        <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '14px', color: '#1e40af' }}>
            Viewing <code style={{ background: '#dbeafe', padding: '2px 6px', borderRadius: '4px', fontSize: '13px' }}>{viewedAddress.slice(0, 6)}…{viewedAddress.slice(-4)}</code> (read-only)
          </span>
          <button onClick={exitViewMode} style={{ fontSize: '13px', padding: '6px 12px', border: '1px solid #93c5fd', background: '#fff', color: '#1e40af', borderRadius: '6px', cursor: 'pointer', fontWeight: 500 }}>
            Exit view mode
          </button>
        </div>
      )}
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
          <div className="header">
            <h1 style={{ fontSize: '1.25rem' }}>Supplied Assets</h1>
          </div>
          {suppliedAssets.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)' }}>No assets supplied.</p>
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
                  <th>Interest Earned</th>
                  <th>Position P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {suppliedAssets.map((a: any, i: number) => {
                  const otherCollateralUsd = collateralUsd - a.valueUsd;
                  const requiredThisAssetUsd = liquidationThreshold > 0 ? (debtUsd / liquidationThreshold) - otherCollateralUsd : 0;
                  const liquidationPrice = requiredThisAssetUsd > 0 ? (requiredThisAssetUsd / a.amount) : 0;
                  const r = applyOverride(a, 'supply');

                  return (
                    <tr key={i}>
                      <td>{a.symbol}</td>
                      <td className="number" data-label="Balance">{a.amount.toFixed(4)}</td>
                      <ValueCell a={a} side="supply" r={r} />
                      <td className="number text-success" data-label="APY">{a.apy.toFixed(2)}%</td>
                      <td className="number" data-label="Liquidation Price">${liquidationPrice > 0 ? liquidationPrice.toFixed(2) : 'Safe'}</td>
                      <td className="number text-success" data-label="Interest Earned">
                        {a.interestEarnedTokens.toFixed(4)} {a.symbol} <br />
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                          +${a.interestEarnedUsd.toFixed(2)}
                        </span>
                      </td>
                      <PnlCell r={r} side="supply" />
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="header">
            <h1 style={{ fontSize: '1.25rem' }}>Borrowed Assets</h1>
          </div>
          {borrowedAssets.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)' }}>No assets borrowed.</p>
          ) : (
            <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Balance</th>
                  <th>Value (USD)</th>
                  <th>APY</th>
                  <th>Interest Paid</th>
                  <th>Position P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {borrowedAssets.map((a: any, i: number) => {
                  const r = applyOverride(a, 'borrow');
                  return (
                    <tr key={i}>
                      <td>{a.symbol}</td>
                      <td className="number" data-label="Balance">{a.amount.toFixed(4)}</td>
                      <ValueCell a={a} side="borrow" r={r} />
                      <td className="number text-danger" data-label="APY">{a.apy.toFixed(2)}%</td>
                      <td className="number text-danger" data-label="Interest Paid">
                        {a.interestPaidTokens.toFixed(4)} {a.symbol} <br />
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                          -${a.interestPaidUsd.toFixed(2)}
                        </span>
                      </td>
                      <PnlCell r={r} side="borrow" />
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
        <div
          onClick={cancelDraft}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: '12px', padding: '24px',
              width: '360px', maxWidth: '90vw',
              boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
            }}
          >
            <h3 style={{ margin: '0 0 4px', fontSize: '1.1rem' }}>
              Set avg {editCtx.side === 'supply' ? 'buy' : 'borrow'} price
            </h3>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '16px' }}>
              {editCtx.asset.symbol} · {editCtx.side}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '0.85rem', marginBottom: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Current price</span>
                <span>${editCtx.currentPrice.toFixed(4)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-secondary)' }}>On-chain avg (from tx history)</span>
                <span>${editCtx.onChainAvg.toFixed(4)}</span>
              </div>
              {editCtx.isOverride && (
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#2563eb' }}>
                  <span>Your current override</span>
                  <span>${(overrides[editCtx.rowKey] ?? 0).toFixed(4)}</span>
                </div>
              )}
            </div>

            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 500, marginBottom: '6px' }}>
              Your avg price (USD)
            </label>
            <input
              type="number"
              step="any"
              value={draftValue}
              autoFocus
              onChange={e => setDraftValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') saveDraft(editCtx.rowKey)
                if (e.key === 'Escape') cancelDraft()
              }}
              placeholder={editCtx.onChainAvg > 0 ? editCtx.onChainAvg.toFixed(4) : '0.00'}
              style={{
                width: '100%', padding: '8px 10px', fontSize: '0.9rem',
                border: '1px solid var(--border-color)', borderRadius: '6px',
                boxSizing: 'border-box',
              }}
            />

            <div style={{ display: 'flex', gap: '8px', marginTop: '20px', justifyContent: 'flex-end' }}>
              {editCtx.isOverride && (
                <button
                  onClick={() => resetOverride(editCtx.rowKey)}
                  style={{
                    padding: '8px 14px', fontSize: '0.85rem', cursor: 'pointer',
                    border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626',
                    borderRadius: '6px', marginRight: 'auto',
                  }}
                >
                  Reset to on-chain
                </button>
              )}
              <button
                onClick={cancelDraft}
                style={{
                  padding: '8px 14px', fontSize: '0.85rem', cursor: 'pointer',
                  border: '1px solid var(--border-color)', background: '#fff',
                  borderRadius: '6px',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => saveDraft(editCtx.rowKey)}
                style={{
                  padding: '8px 14px', fontSize: '0.85rem', cursor: 'pointer',
                  border: 'none', background: '#2563eb', color: '#fff',
                  borderRadius: '6px', fontWeight: 500,
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
