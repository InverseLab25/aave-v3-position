import { useState, useEffect, lazy, Suspense, type ComponentType } from 'react'
import { useConnection } from 'wagmi'
import { useAavePositions } from '../hooks/useAavePositions'
import { exitViewMode } from '../hooks/useViewMode'

/**
 * Modals only ever render in response to a click, so eagerly bundling them cost every
 * visitor ~70 kB of JS they may never open. Suspense is folded into the wrapper so the
 * call sites below stay exactly as they were.
 */
function lazyModal<P extends object>(load: () => Promise<ComponentType<P>>) {
  const Loaded = lazy(async () => ({ default: await load() }))
  return function LazyModal(props: P) {
    return (
      <Suspense fallback={null}>
        <Loaded {...props} />
      </Suspense>
    )
  }
}

const ClosePositionModal = lazyModal(() => import('./ClosePositionModal').then((m) => m.ClosePositionModal))
const LeveragePanel = lazyModal(() => import('./leverage/LeveragePanel').then((m) => m.LeveragePanel))
const WithdrawModal = lazyModal(() => import('./WithdrawModal').then((m) => m.WithdrawModal))
const AssetsToSupplyModal = lazyModal(() => import('./AssetsToSupplyModal').then((m) => m.AssetsToSupplyModal))
const AssetsToBorrowModal = lazyModal(() => import('./AssetsToBorrowModal').then((m) => m.AssetsToBorrowModal))
const BorrowRepayModal = lazyModal(() => import('./BorrowRepayModal').then((m) => m.BorrowRepayModal))
import { T, modalStyle, labelStyle, inputStyle } from '../styles/theme'
import { getChainConfig } from '../config/chains'
import { LiquidationPriceBlock } from './LiquidationPriceBlock'
import { TxHistoryList } from './TxHistoryList'
import { useHistorySync } from '../hooks/useHistorySync'
import { computeLiquidationView, hasLiquidationRowsToShow, toCollateralInputs, toDebtInputs } from '../utils/liquidation'
import { portfolioPnl, resolveEntryPrice, rowPnl, type RowPnl } from '../lib/positionPnl'
import type { AvailableReserve, BorrowedAsset, SuppliedAsset } from '../hooks/useAavePositions'

const AVG_PRICE_OVERRIDE_STORAGE_KEY = 'aave.avgPriceOverrides.v1'

interface AavePositionProps {
  viewAddress?: `0x${string}`
  viewChainId?: number
  apiNativePrice?: number | null
  /** Whether this is the tab on screen. Passed down so a hidden panel stops pricing. */
  active?: boolean
}

function StatBox({ label, value, valueClass, title }: { label: string; value: React.ReactNode; valueClass?: string; title?: string }) {
  return (
    <div className="stat" title={title}>
      <label>{label}</label>
      <div className={valueClass}>{value}</div>
    </div>
  )
}

function DetailRow({ label, value, icon }: { label: string; value: React.ReactNode; icon: React.ReactNode }) {
  return (
    <div className="info-row" style={{ fontSize: T.fontSize.md, padding: 0, paddingBottom: T.space[2] }}>
      <span className="info-row-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        {icon}
        {label}
      </span>
      <span className="info-row-value" style={{ fontSize: '1.25rem' }}>{value}</span>
    </div>
  )
}

/** A signed dollar figure, always carrying its sign. */
const fmtSigned = (n: number) => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`

/**
 * Value(USD) cell — the value, and a clickable Avg row that opens the basis editor.
 *
 * At module scope on purpose. Declared inside the parent it was a NEW component type on every
 * render, so React tore down and rebuilt every cell in both tables whenever a price or balance
 * refetch landed, instead of diffing them. What it used to close over comes in as props.
 */
function ValueCell({ a, side, r, chainId, apiNativePrice, onEdit }: {
  a: SuppliedAsset | BorrowedAsset
  side: 'supply' | 'borrow'
  r: RowPnl | null
  chainId: number
  apiNativePrice?: number | null
  onEdit: (rowKey: string, avg: number) => void
}) {
  const rowKey = `${side}:${a.underlyingAsset.toLowerCase()}`
  const effectiveAvgEntry = r?.effectiveAvgEntry ?? 0
  // Reported by the resolver rather than re-derived from the override map, so the highlight and
  // the number can never disagree about where the figure came from.
  const isOverride = r?.source === 'override'
  const chainConfig = getChainConfig(chainId)
  const nativeWrappedSymbol = chainConfig?.defaultTokens?.[0]?.symbol?.toUpperCase() || 'WETH'
  const isNativeToken = a.symbol.toUpperCase() === nativeWrappedSymbol
  const currentPrice = (isNativeToken && apiNativePrice) ? apiNativePrice : Number(a.priceInUsd)
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
          onClick={() => onEdit(rowKey, effectiveAvgEntry)}
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
 * P&L cell with breakdown on separate lines. Shared by both tables.
 *
 * At module scope for the same reason as {@link ValueCell}.
 */
function PnlCell({ r, side }: { r: RowPnl | null; side: 'supply' | 'borrow' }) {
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

export function AavePosition({ viewAddress, viewChainId, apiNativePrice, active }: AavePositionProps = {}) {
  const {
    isConnected,
    isViewMode,
    viewedAddress,
    isLoading,
    collateralUsd,
    debtUsd,
    collateralBase,
    debtBase,
    ltvBps,
    liquidationThresholdBps,
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
    collateralFlags,
    hasAnyCollateralEnabled,
    eModeExcludedReserves,
    hasReadError,
    chainId,
    realizedByTx
  } = useAavePositions({ viewAddress, viewChainId })

  /** Local history belongs to the wallet in this browser, never to an address being viewed. */
  const { address: connectedAddress } = useConnection()

  /**
   * Reads the connected wallet's own history back off the chain, on every chain it could have one.
   *
   * Not scoped to the address being VIEWED: this fills in what this browser never saw — a position
   * opened on another device, or before the storage was cleared — which is a fact about the wallet
   * rather than about whichever address is on screen.
   */
  const historySync = useHistorySync(availableReserves, chainId)

  const [closeTarget, setCloseTarget] = useState<BorrowedAsset | null>(null)
  const [withdrawTarget, setWithdrawTarget] = useState<{ asset: SuppliedAsset } | null>(null)
  const [borrowRepayTarget, setBorrowRepayTarget] = useState<{ asset: BorrowedAsset, tab: 'borrow' | 'repay' } | null>(null)
  const [isAssetsToSupplyModalOpen, setIsAssetsToSupplyModalOpen] = useState(false)
  const [isAssetsToBorrowModalOpen, setIsAssetsToBorrowModalOpen] = useState(false)


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
   * The current price this row is marked against.
   *
   * The native wrapper gets an API price when one is available, because Aave's oracle for it can
   * lag the market by more than the position's whole P&L.
   */
  const priceOf = (a: { symbol: string; priceInUsd: string }) => {
    const chainConfig = getChainConfig(chainId)
    const nativeWrappedSymbol = chainConfig?.defaultTokens?.[0]?.symbol?.toUpperCase() || 'WETH'
    const isNativeToken = a.symbol.toUpperCase() === nativeWrappedSymbol
    return isNativeToken && apiNativePrice ? apiNativePrice : Number(a.priceInUsd)
  }

  /**
   * One row's P&L, with the entry price resolved from the three sources that can supply one.
   *
   * The arithmetic and the precedence both live in `lib/positionPnl` now — this only gathers the
   * arguments. Rows are keyed `side:address` so a WETH supply override cannot leak into a WETH
   * borrow, which are opposite positions in the same asset.
   */
  const pnlFor = (
    a: {
      positionPnl?: { avgEntryPriceUsd: number; realizedPnlUsd: number; interestUsd: number }
      amount: number
      interestEarnedTokens?: number
      interestPaidTokens?: number
      priceInUsd: string
      underlyingAsset: string
      symbol: string
    },
    side: 'supply' | 'borrow',
  ): RowPnl | null => {
    const pnl = a.positionPnl
    if (!pnl) return null
    const rowKey = `${side}:${a.underlyingAsset.toLowerCase()}`

    return rowPnl({
      side,
      entry: resolveEntryPrice({
        override: overrides[rowKey],
        measured: pnl.avgEntryPriceUsd,
      }),
      currentPriceUsd: priceOf(a),
      amount: a.amount,
      interestTokens: (side === 'supply' ? a.interestEarnedTokens : a.interestPaidTokens) ?? 0,
      interestUsd: pnl.interestUsd,
      realizedPnlUsd: pnl.realizedPnlUsd,
    })
  }

  // Computed ONCE and read by both the headline and the rows, which is what makes the comment
  // below structurally true rather than a hope — and halves the work, since `pnlFor` used to run
  // for every asset again on the way into each table.
  const suppliedPnl = suppliedAssets.map((a) => pnlFor(a, 'supply'))
  const borrowedPnl = borrowedAssets.map((a) => pnlFor(a, 'borrow'))

  // Summed from the same rows the table renders, so the headline cannot disagree with the lines.
  // Positions that are over contribute nothing: they have no row, and what each of their closes
  // made is reported per transaction in Recent activity instead.
  const effectiveTotalPnlUsd = portfolioPnl(
    [...suppliedPnl, ...borrowedPnl].filter((r): r is RowPnl => r !== null),
  )

  /** Value(USD) cell — shows just the value + a clickable Avg row that opens the editor modal. */
  /**
   * Look up the asset behind the currently-open editor key, so the modal can pull
   * on-chain avg, current price, symbol, etc. Returns null if the key doesn't match anything.
   */
  const getEditContext = () => {
    if (!editingKey) return null
    const [side, addr] = editingKey.split(':') as ['supply' | 'borrow', string]
    const list = side === 'supply' ? suppliedAssets : borrowedAssets
    const asset = list.find((a: SuppliedAsset | BorrowedAsset) => a.underlyingAsset.toLowerCase() === addr)
    if (!asset) return null
    const chainConfig = getChainConfig(chainId)
    const nativeWrappedSymbol = chainConfig?.defaultTokens?.[0]?.symbol?.toUpperCase() || 'WETH'
    const isNativeToken = asset.symbol.toUpperCase() === nativeWrappedSymbol
    const currentPrice = (isNativeToken && apiNativePrice) ? apiNativePrice : Number(asset.priceInUsd)

    return {
      side,
      asset,
      rowKey: editingKey,
      measuredAvg: asset.positionPnl?.avgEntryPriceUsd ?? 0,
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
  // Checked BEFORE the empty-position branch, because a failed read looks exactly like an
  // empty account: zeroed totals and no assets. Falling through would invite someone with a
  // real position to open a leveraged one sized against an account that reads as empty.
  if (hasReadError) {
    return (
      <div className="dashboard-container">
        {isViewMode && renderViewModeBanner()}
        <div className="card" style={{ textAlign: 'center', padding: T.space[8] }}>
          <h2 style={{ fontSize: T.fontSize.xl, margin: `0 0 ${T.space[2]}` }}>
            Could not read your Aave position
          </h2>
          <p style={{ color: T.textMuted, margin: 0 }}>
            The network request failed, so this is not a picture of your account. Reload before
            acting on anything here.
          </p>
        </div>
      </div>
    )
  }
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

        <LeveragePanel
          active={active}
          suppliedAssets={suppliedAssets}
          borrowedAssets={borrowedAssets}
          availableReserves={availableReserves}
          collateralFlags={collateralFlags}
          hasAnyCollateralEnabled={hasAnyCollateralEnabled}
          eModeExcludedReserves={eModeExcludedReserves}
          viewAddress={viewAddress}
          existingCollateralUsd={collateralBase}
          existingDebtUsd={debtBase}
          existingLtvBps={ltvBps}
          existingLiquidationThresholdBps={liquidationThresholdBps}
        />


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
            suppliedAssets={suppliedAssets}
            onClose={() => setIsAssetsToBorrowModalOpen(false)}
          />
        )}

        {/* Reachable from here too: the account that just closed its last position lands on this
            screen, and it is the one most likely to be looking for what that close settled at. */}
        <TxHistoryList
        wallet={viewAddress ? undefined : connectedAddress}
        chainId={chainId}
        sync={historySync}
        realizedByTx={realizedByTx}
      />
      </div>
    )
  }

  const netInterestUsd = totalInterestEarnedUsd - totalInterestPaidUsd
  const exposure = (collateralUsd - debtUsd) > 0 ? (collateralUsd / (collateralUsd - debtUsd)) : 1
  const borrowPowerUsed = (debtUsd + availableBorrowsUsd) > 0 ? (debtUsd / (debtUsd + availableBorrowsUsd)) * 100 : 0

  // Debt rows included: a short (stable collateral, volatile debt) is liquidated by the DEBT
  // rising, and a collateral-only view answers the wrong question for it entirely.
  const liquidationView = computeLiquidationView(
    toCollateralInputs(suppliedAssets), debtUsd, toDebtInputs(borrowedAssets),
  )
  const chainConfig = getChainConfig(chainId)
  const nativeWrappedSymbol = chainConfig?.defaultTokens?.[0]?.symbol?.toUpperCase() || 'WETH'
  const ethPriceUsd = Number(availableReserves?.find((r: AvailableReserve) => r.symbol.toUpperCase() === nativeWrappedSymbol)?.priceInUsd || 0)

  return (
    <div className="dashboard-container">
      {renderViewModeBanner()}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: T.space[4], marginBottom: T.space[4] }}>
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="header">
            <h1 style={{ fontSize: T.fontSize.lg }}>Aave V3 Portfolio</h1>
          </div>

          <div className="stats-grid">
            <StatBox label="Net Worth" value={`$${(collateralUsd - debtUsd).toFixed(2)}`} />
            <StatBox label="Net APY" value={`${netApy.toFixed(2)}%`} valueClass={netApy >= 0 ? 'text-success' : 'text-danger'} />
            <StatBox label="Net Interest (Till Date)" value={fmtSigned(netInterestUsd)} valueClass={netInterestUsd >= 0 ? 'text-success' : 'text-danger'} />
            <StatBox
              label="Position P&amp;L"
              value={fmtSigned(effectiveTotalPnlUsd)}
              valueClass={effectiveTotalPnlUsd >= 0 ? 'text-success' : 'text-danger'}
              title="Unrealized price P&L + realized P&L from partial exits + net interest, on the positions open now. A position closed out entirely is reported per transaction in Recent activity. Uses your override avg price where set."
            />
            <StatBox label="Health Factor" value={formattedHealthFactor === '∞' ? '∞' : Number(formattedHealthFactor).toFixed(2)} />
            <StatBox label="Total Supplied" value={`$${collateralUsd.toFixed(2)}`} />
            <StatBox label="Total Borrowed" value={`$${debtUsd.toFixed(2)}`} />
          </div>
        </div>

        <div className="card" style={{ marginBottom: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="header">
            <h1 style={{ fontSize: T.fontSize.lg }}>Details</h1>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, justifyContent: 'space-between', marginTop: T.space[2] }}>
            <LiquidationPriceBlock view={liquidationView} />
            {hasLiquidationRowsToShow(liquidationView) && (
              <div style={{ borderTop: `1px dashed ${T.border}`, margin: `${T.space[2]} 0` }} />
            )}
            <DetailRow
              label="Avg. LTV"
              value={`${ltvPercent.toFixed(2)}%`}
              icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>}
            />
            <DetailRow
              label="Exposure"
              value={`${exposure.toFixed(2)}X`}
              icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}><circle cx="12" cy="12" r="10"></circle><polyline points="12 16 16 12 12 8"></polyline><line x1="8" y1="12" x2="16" y2="12"></line></svg>}
            />
            <DetailRow
              label="Borrow power used"
              value={`${borrowPowerUsed.toFixed(2)}%`}
              icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}><circle cx="12" cy="12" r="10"></circle><polyline points="12 8 8 12 12 16"></polyline><line x1="16" y1="12" x2="8" y2="12"></line></svg>}
            />
            <DetailRow
              label="Left to borrow"
              value={`$${availableBorrowsUsd.toFixed(2)}`}
              icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}><path d="M12 2v20"></path><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>}
            />
          </div>
        </div>
      </div>

      <LeveragePanel
        active={active}
        suppliedAssets={suppliedAssets}
        borrowedAssets={borrowedAssets}
        availableReserves={availableReserves}
        collateralFlags={collateralFlags}
        hasAnyCollateralEnabled={hasAnyCollateralEnabled}
        eModeExcludedReserves={eModeExcludedReserves}
        viewAddress={viewAddress}
        existingCollateralUsd={collateralBase}
        existingDebtUsd={debtBase}
        existingLtvBps={ltvBps}
        existingLiquidationThresholdBps={liquidationThresholdBps}
      />

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
                  {suppliedAssets.map((a: SuppliedAsset, i: number) => {
                    const r = suppliedPnl[i];

                    return (
                      <tr key={i}>
                        <td style={{ fontWeight: 600 }}>{a.symbol}</td>
                        <td className="number" data-label="Balance">{a.amount.toFixed(4)}</td>
                        <ValueCell a={a} side="supply" r={r} chainId={chainId} apiNativePrice={apiNativePrice} onEdit={openEditor} />
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
                    <th>Interest Paid</th>
                    <th>Position P&amp;L</th>
                    {!isViewMode && <th style={{ textAlign: 'right' }}>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {borrowedAssets.map((a: BorrowedAsset, i: number) => {
                    const r = borrowedPnl[i];
                    return (
                      <tr key={i}>
                        <td style={{ fontWeight: 600 }}>{a.symbol}</td>
                        <td className="number" data-label="Balance">{a.amount.toFixed(4)}</td>
                        <ValueCell a={a} side="borrow" r={r} chainId={chainId} apiNativePrice={apiNativePrice} onEdit={openEditor} />
                        <td className="number text-danger" data-label="APY">{a.apy.toFixed(2)}%</td>
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

      {/* Account-level, not flow-level: an open is recorded by the leverage panel and a close by
          the close modal, and someone looking for either goes to their position rather than to
          whichever form produced it. */}
      <TxHistoryList
        wallet={viewAddress ? undefined : connectedAddress}
        chainId={chainId}
        sync={historySync}
        realizedByTx={realizedByTx}
      />

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
              {/* Every lot at what it actually cost: the router's rate where a swap bought it,
                  the oracle price where it was supplied from the wallet. Both rows say which one
                  the P&L is using, because an override that looked ignored was the whole
                  confusion this replaced. */}
              <div className="info-row" style={editCtx.isOverride ? undefined : { color: T.primary }}>
                <span className="info-row-label">
                  Weighted avg {editCtx.side === 'supply' ? 'buy' : 'borrow'}
                  {editCtx.isOverride ? '' : ' · in use'}
                </span>
                <span className="info-row-value" style={{ fontWeight: editCtx.isOverride ? 400 : 600 }}>
                  ${editCtx.measuredAvg.toFixed(4)}
                </span>
              </div>
              {editCtx.isOverride && (
                <div className="info-row" style={{ color: T.primary }}>
                  <span>Your override · in use</span>
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
              // What the box gives you if you type nothing, so it has to agree with what Reset
              // restores: the fills first, the indexer only when there are none.
              placeholder={editCtx.measuredAvg > 0 ? editCtx.measuredAvg.toFixed(4) : '0.00'}
              style={inputStyle}
            />

            <div style={{ display: 'flex', gap: T.space[2], marginTop: T.space[5], justifyContent: 'flex-end' }}>
              {editCtx.isOverride && (
                <button
                  onClick={() => resetOverride(editCtx.rowKey)}
                  style={{ marginRight: 'auto', padding: '8px 14px', fontSize: T.fontSize.sm, background: T.dangerBg, color: T.danger, border: `1px solid ${T.dangerBorder}`, borderRadius: T.radius.md, cursor: 'pointer' }}
                >
                  Reset to measured
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
          suppliedAssets={suppliedAssets}
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
          suppliedAssets={suppliedAssets}
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
          suppliedAssets={suppliedAssets}
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
          suppliedAssets={suppliedAssets}
          onClose={() => setBorrowRepayTarget(null)}
        />
      )}

      {closeTarget && (
        <ClosePositionModal
          active={active}
          borrowedAsset={closeTarget}
          suppliedAssets={suppliedAssets}
          collateralUsd={collateralUsd}
          debtUsd={debtUsd}
          liquidationThreshold={liquidationThreshold}
          onClose={() => setCloseTarget(null)}
        />
      )}
    </div>
  )
}
