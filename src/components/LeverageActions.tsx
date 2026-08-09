import { useMemo, useState } from 'react'
import { erc20Abi, formatUnits, parseUnits } from 'viem'
import { useChainId, useConnection, useReadContract } from 'wagmi'
import type { AvailableReserve, SuppliedAsset } from '../hooks/useAavePositions'
import { useStrategiesOpen } from '../hooks/useStrategiesOpen'
import { getStrategiesAddress } from '../config/chains'
import { leverageCeilingBps, sliderMax } from '../lib/openPlan'
import { PRICE_IMPACT_BLOCK_PERCENT } from '../lib/swapRoute'
import { OpenPositionForm } from './OpenPositionForm'
import { PositionPreview } from './PositionPreview'
import { ExplorerLink } from './ExplorerLink'
import { T } from '../styles/theme'

interface LeverageActionsProps {
  suppliedAssets: SuppliedAsset[]
  availableReserves: AvailableReserve[]
  viewAddress?: `0x${string}`
}

type Direction = 'long' | 'short'

const SIDEBAR: Array<{ key: Direction; title: string; blurb: (v: string, s: string) => string }> = [
  { key: 'long', title: 'Long', blurb: (v, s) => `Collateralize ${v}, borrow ${s}.` },
  { key: 'short', title: 'Short', blurb: (v, s) => `Collateralize ${s}, borrow ${v}.` },
]

const DEFAULT_SLIPPAGE_BPS = 50n

export function LeverageActions({ availableReserves, viewAddress }: LeverageActionsProps) {
  const chainId = useChainId()
  const { address } = useConnection()
  const contract = getStrategiesAddress(chainId)

  const [direction, setDirection] = useState<Direction>('long')
  const [marginIn, setMarginIn] = useState<'collateral' | 'debt'>('collateral')
  const [marginStr, setMarginStr] = useState('')
  // What the user last dragged to (or the panel's default) — NOT necessarily what is actually
  // used below. `leverageBps` derives the clamped, in-force value from this every render.
  const [requestedLeverageBps, setRequestedLeverageBps] = useState(20_000n)
  const [dangerEnabled, setDangerEnabled] = useState(false)

  // Default pair: the first volatile reserve against the first stable one.
  const volatileReserve = availableReserves.find((r) => Number(r.priceInUsd) > 1.02) ?? availableReserves[0]
  const stableReserve = availableReserves.find((r) => Math.abs(Number(r.priceInUsd) - 1) <= 0.02)

  const long = direction === 'long'
  const collateralReserve = long ? volatileReserve : stableReserve
  const debtReserve = long ? stableReserve : volatileReserve
  const mode = long ? (marginIn === 'collateral' ? 1 : 2) : marginIn === 'debt' ? 3 : 4

  const marginReserve = marginIn === 'collateral' ? collateralReserve : debtReserve

  // Margin is pulled from the WALLET (safeTransferFrom(msg.sender, ...)), not from what is
  // already supplied to Aave — suppliedAssets is structurally always empty for the
  // empty-portfolio mount this panel exists to serve. Same pattern BorrowRepayModal uses for
  // a wallet ERC-20 balance.
  const { data: marginWalletBalance } = useReadContract({
    chainId,
    address: marginReserve?.underlyingAsset,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!marginReserve },
  })
  const marginBalance = marginWalletBalance
    ? Number(formatUnits(marginWalletBalance as bigint, marginReserve?.raw.decimals ?? 18))
    : 0

  // The ceiling actually in force right now — the danger-zone toggle and the asset's own LTV
  // both bear on it, so it is recomputed every render rather than cached.
  const { soft: leverageSoftBps, hard: leverageHardBps } = collateralReserve
    ? leverageCeilingBps({
        ltvBps: collateralReserve.raw.ltvBps,
        liquidationThresholdBps: collateralReserve.raw.liquidationThresholdBps,
      })
    : { soft: null, hard: null }
  const leverageMaxBps = leverageHardBps !== null
    ? sliderMax(leverageSoftBps, leverageHardBps, dangerEnabled)
    : null

  // Derived from `requestedLeverageBps`, not synced into it via an effect: whatever the user
  // last dragged to is remembered, but never exceeds the ceiling actually in force. This is
  // what keeps the mount default (2.00x, not universally safe — a tight-LTV asset's soft
  // ceiling can sit below it) and the danger-zone toggle turning back off (which lowers the
  // slider's `max` alone, not any state) from ever reaching `sizeOpen` unclamped.
  const leverageBps = leverageMaxBps !== null && requestedLeverageBps > leverageMaxBps
    ? leverageMaxBps
    : requestedLeverageBps

  const input = useMemo(() => {
    if (!contract || !volatileReserve || !stableReserve || !collateralReserve || !debtReserve) return null
    let marginAmount: bigint
    try {
      marginAmount = parseUnits(marginStr || '0', marginReserve?.raw.decimals ?? 18)
    } catch {
      return null
    }
    if (marginAmount <= 0n) return null
    return {
      contract,
      mode: mode as 1 | 2 | 3 | 4,
      volatile: volatileReserve.underlyingAsset,
      stable: stableReserve.underlyingAsset,
      marginAmount,
      leverageBps,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
      reserves: {
        collateral: { address: collateralReserve.underlyingAsset, symbol: collateralReserve.symbol, ...collateralReserve.raw },
        debt: { address: debtReserve.underlyingAsset, symbol: debtReserve.symbol, ...debtReserve.raw },
      },
    }
  }, [contract, mode, volatileReserve, stableReserve, collateralReserve, debtReserve, marginReserve, marginStr, leverageBps])

  const {
    preview, previewError, isQuoting, execute, step, execError, execRemedy, txHash, refresh,
  } = useStrategiesOpen(input)

  // The contract is undeployed, or we are looking at someone else's portfolio.
  if (!contract || viewAddress) return null

  const paused = previewError?.kind === 'paused'
  const sizingMessage = previewError && !paused ? previewError.message : null
  const busy = step === 'approving' || step === 'signing' || step === 'sending'
  const priceImpactBlocked =
    preview?.priceImpactPercent != null && preview.priceImpactPercent > PRICE_IMPACT_BLOCK_PERCENT
  const remedyHint = execRemedy === 'widen-slippage'
    ? 'Try again with a wider slippage tolerance.'
    : execRemedy === 'requote'
      ? 'The rate moved — refresh the quote and try again.'
      : execRemedy === 'refresh'
        ? 'Refresh and try again.'
        : null

  return (
    <div style={{
      marginTop: T.space[4], background: T.surface,
      border: `1px solid ${T.border}`, borderRadius: T.radius.lg, boxShadow: T.shadow.card,
    }}>
      <div style={{ display: 'flex', gap: T.space[2], padding: T.space[3], borderBottom: `1px solid ${T.border}` }}>
        <span style={{ fontSize: T.fontSize.xs, color: T.textMuted, textTransform: 'uppercase', alignSelf: 'center' }}>
          Actions
        </span>
        <button role="tab" aria-selected style={{ padding: `${T.space[1]} ${T.space[3]}`, borderRadius: T.radius.md, border: 'none', background: T.text, color: '#fff', cursor: 'pointer' }}>
          Open
        </button>
        <button role="tab" disabled title="Coming soon" style={{ padding: `${T.space[1]} ${T.space[3]}`, borderRadius: T.radius.md, border: 'none', background: 'transparent', color: T.textMuted }}>
          Boost
        </button>
        <button role="tab" disabled title="Coming soon" style={{ padding: `${T.space[1]} ${T.space[3]}`, borderRadius: T.radius.md, border: 'none', background: 'transparent', color: T.textMuted }}>
          Repay
        </button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap' }}>
        <div style={{ flex: '0 0 220px', borderRight: `1px solid ${T.border}`, padding: T.space[3] }}>
          {SIDEBAR.map((item) => (
            <button
              key={item.key}
              onClick={() => setDirection(item.key)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                padding: T.space[3], marginBottom: T.space[2],
                borderRadius: T.radius.md,
                border: `1px solid ${direction === item.key ? T.primary : 'transparent'}`,
                background: direction === item.key ? T.bg : 'transparent',
              }}
            >
              <div style={{ fontWeight: 600 }}>{item.title}</div>
              <div style={{ fontSize: T.fontSize.sm, color: T.textMuted }}>
                {item.blurb(volatileReserve?.symbol ?? '—', stableReserve?.symbol ?? '—')}
              </div>
            </button>
          ))}
        </div>

        <div style={{ flex: '1 1 320px', padding: T.space[3], display: 'flex', flexDirection: 'column', gap: T.space[3] }}>
          <div style={{ fontSize: T.fontSize.sm, color: T.textMuted }}>
            Supply {collateralReserve?.symbol} → Borrow {debtReserve?.symbol} → Swap → Supply{' '}
            {collateralReserve?.symbol}, in one transaction.
          </div>

          {paused && (
            <div style={{ padding: T.space[2], borderRadius: T.radius.md, background: '#fef3c7', color: '#92400e', fontSize: T.fontSize.sm }}>
              Leverage is paused.
            </div>
          )}

          <OpenPositionForm
            marginStr={marginStr}
            onMarginChange={setMarginStr}
            marginBalance={marginBalance.toString()}
            marginSymbol={marginReserve?.symbol ?? '—'}
            marginIn={marginIn}
            onMarginInChange={setMarginIn}
            collateralSymbol={collateralReserve?.symbol ?? '—'}
            debtSymbol={debtReserve?.symbol ?? '—'}
            leverageBps={leverageBps}
            onLeverageChange={setRequestedLeverageBps}
            ltvBps={collateralReserve?.raw.ltvBps ?? 0n}
            liquidationThresholdBps={collateralReserve?.raw.liquidationThresholdBps ?? 0n}
            dangerEnabled={dangerEnabled}
            onDangerToggle={setDangerEnabled}
          />

          {sizingMessage && (
            <div style={{ fontSize: T.fontSize.sm, color: T.danger }}>{sizingMessage}</div>
          )}

          <PositionPreview
            preview={preview}
            collateralSymbol={collateralReserve?.symbol ?? '—'}
            debtSymbol={debtReserve?.symbol ?? '—'}
            collateralDecimals={collateralReserve?.raw.decimals ?? 18}
            debtDecimals={debtReserve?.raw.decimals ?? 18}
            collateralPriceUsd={Number(collateralReserve?.priceInUsd ?? 0)}
            debtPriceUsd={Number(debtReserve?.priceInUsd ?? 0)}
            liquidationThreshold={collateralReserve?.liquidationThreshold ?? 0}
          />

          {priceImpactBlocked && (
            <div style={{ fontSize: T.fontSize.sm, color: T.danger }}>
              This route would give up {preview?.priceImpactPercent?.toFixed(2)}% of the position to
              price impact — too much to submit. Wait for deeper liquidity or reduce the size.
            </div>
          )}

          <div style={{ fontSize: T.fontSize.sm, color: T.textMuted }}>
            {(['approving', 'signing', 'sending'] as const).map((s, i) => (
              <span key={s} style={{ fontWeight: step === s ? 700 : 400, color: step === s ? T.text : T.textMuted }}>
                {i > 0 && ' · '}
                {s === 'approving' ? 'approve' : s === 'signing' ? 'sign' : 'send'}
              </span>
            ))}
          </div>

          <button
            onClick={() => void execute()}
            disabled={!preview || isQuoting || paused || busy || priceImpactBlocked}
            style={{
              padding: T.space[3], borderRadius: T.radius.md, border: 'none', cursor: 'pointer',
              background: !preview || isQuoting || paused || busy || priceImpactBlocked ? T.border : T.primary,
              color: '#fff', fontWeight: 600,
            }}
          >
            Open position
          </button>

          {execError && (
            <div style={{ fontSize: T.fontSize.sm, color: T.danger }}>
              {execError}
              {remedyHint && <span style={{ color: T.textMuted }}> {remedyHint}</span>}
              {' '}
              <button
                onClick={refresh}
                style={{
                  border: 'none', background: 'none', padding: 0, cursor: 'pointer',
                  color: T.primary, fontWeight: 600, fontSize: T.fontSize.sm,
                }}
              >
                Retry
              </button>
            </div>
          )}

          {step === 'done' && txHash && <ExplorerLink hash={txHash} chainId={chainId} />}
        </div>
      </div>
    </div>
  )
}
