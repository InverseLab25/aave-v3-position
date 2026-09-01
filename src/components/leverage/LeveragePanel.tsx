import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { erc20Abi, formatUnits, parseUnits } from 'viem'
import { useChainId, useConnection, useReadContract } from 'wagmi'
import type { AvailableReserve, BorrowedAsset, SuppliedAsset } from '../../hooks/useAavePositions'
import { useLeverageOpen } from '../../hooks/useLeverageOpen'
import {
  deriveOpen,
  collateralEnablement,
  leverageErrorMessage,
  maxBorrowAmount,
  maxSupplyAmount,
  projectOpen,
  resolveRoles,
  usdValue,
  validateSizing,
  type Direction,
  type MarginAsset,
  type MarginLocation,
} from '../../lib/leverage'
import { seedBorrow } from '../../lib/solveBorrow'
import { BPS } from '../../lib/strategies-sdk/sizing'
import { PRICE_IMPACT_BLOCK_PERCENT } from '../../lib/swapRoute'
import { getStrategiesAddress } from '../../config/chains'
import { isVolatilePrice, toCollateralInputs } from '../../utils/liquidation'
import { AmountField } from './AmountField'
import { ConfirmLeverageModal } from './ConfirmLeverageModal'
import { SlippageField } from './SlippageField'
import { useRecordOutcome } from '../../hooks/useRecordOutcome'
import { buildTokenMap, positionTokens, type TokenMetaSource } from '../../lib/tokenMeta'
import { hideTokens } from '../../lib/txOutcome'
import { defaultPair } from './defaultPair'
import { PairPicker, type BoostPosition, type LeverageTab } from './PairPicker'
import { PositionSummary } from './PositionSummary'
import { DEFAULT_SLIPPAGE_PERCENT, toSlippageBps } from './slippage'
import { T } from '../../styles/theme'

/**
 * A reserve as the token-metadata builders want it.
 *
 * Decimals come from `raw`, which is the on-chain value; the sibling field is a display Number.
 */
const toTokenSource = (r: AvailableReserve | undefined): TokenMetaSource | null =>
  r
    ? {
      symbol: r.symbol,
      decimals: r.raw.decimals,
      underlyingAsset: r.underlyingAsset,
      aTokenAddress: r.aTokenAddress,
      variableDebtTokenAddress: r.variableDebtTokenAddress,
    }
    : null

const subscribeVisibility = (onChange: () => void) => {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}
const isTabVisible = () => document.visibilityState === 'visible'

interface LeveragePanelProps {
  suppliedAssets: SuppliedAsset[]
  borrowedAssets: BorrowedAsset[]
  availableReserves: AvailableReserve[]
  /** Per-reserve collateral state for this account, keyed by lowercased underlying address. */
  collateralFlags: Record<string, { scaledATokenBalance: bigint; enabledOnUser: boolean }>
  /** Whether ANY reserve is switched on as collateral — see `collateralEnablement`. */
  hasAnyCollateralEnabled: boolean
  /** Reserves the user's eMode category excludes from collateral, lowercased. Empty when off. */
  eModeExcludedReserves: Record<string, boolean>
  viewAddress?: `0x${string}`
  /**
   * Whether the tab holding this panel is the one on screen. False stops quoting.
   *
   * AavePosition is hidden rather than unmounted when the user leaves it, so without this the
   * panel keeps re-pricing a screen nobody can see every time prices or balances refetch.
   */
  active?: boolean
  /** `getUserAccountData` totals, 8dp USD — the account the new position lands on top of. */
  existingCollateralUsd: bigint
  existingDebtUsd: bigint
  /** That account's collateral-weighted LTV and liquidation threshold, bps, eMode included. */
  existingLtvBps: bigint
  existingLiquidationThresholdBps: bigint
}

/** Parse a typed amount. Total by construction — the field only ever emits digits and one dot. */
function parseAmount(str: string, decimals: number): bigint {
  if (!str || str === '.') return 0n
  try {
    return parseUnits(str, decimals)
  } catch {
    return 0n
  }
}

function display(amount: bigint, decimals: number, places: number): string {
  return Number(formatUnits(amount, decimals)).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: places,
  })
}

/**
 * Open a leveraged long or short, or boost one the account already holds.
 *
 * Long and short take two typed amounts — a MARGIN posted from the wallet and a SUPPLY that
 * lands in the pool. Boost takes only the supply: it posts no margin, and levers the borrow
 * power the existing position already carries. Everything else is derived — the flash covers the
 * gap, and the borrow is solved against the live route so it always repays that flash. See
 * `lib/leverage.ts` for the model.
 */
export function LeveragePanel({
  suppliedAssets, borrowedAssets, availableReserves, collateralFlags, hasAnyCollateralEnabled,
  eModeExcludedReserves, viewAddress, active,
  existingCollateralUsd, existingDebtUsd, existingLtvBps, existingLiquidationThresholdBps,
}: LeveragePanelProps) {
  // The browser tab's own visibility, alongside the in-app one. A backgrounded window is just as
  // unwatched as a hidden tab, and `visibilitychange` is the only thing that moves this.
  const tabVisible = useSyncExternalStore(subscribeVisibility, isTabVisible, () => true)
  const chainId = useChainId()
  const { address } = useConnection()
  const contract = getStrategiesAddress(chainId)

  const [tab, setTab] = useState<LeverageTab>('long')
  const [subjectOverride, setSubjectOverride] = useState<`0x${string}` | null>(null)
  const [quoteOverride, setQuoteOverride] = useState<`0x${string}` | null>(null)
  const [marginAssetOverride, setMarginAssetOverride] = useState<MarginAsset | null>(null)
  const [positionOverride, setPositionOverride] = useState<string | null>(null)
  /** Which leg the boost amount is typed in — the supply asset or the borrow asset. */
  const [boostDenomOverride, setBoostDenomOverride] = useState<'collateral' | 'debt' | null>(null)
  const [marginStr, setMarginStr] = useState('')
  const [supplyStr, setSupplyStr] = useState('')
  const [danger, setDanger] = useState(false)
  /**
   * Held as the percent the field shows rather than as bps, so a half-typed "0." survives the
   * round trip. `toSlippageBps` is the only thing that reads it, and it clamps.
   */
  const [slippagePercent, setSlippagePercent] = useState(DEFAULT_SLIPPAGE_PERCENT)
  /**
   * The aggregator the user pinned in the route list, or null while the ranking decides.
   *
   * Deliberately not cleared when the pair or the amounts change: a pin says which aggregator
   * this user trusts, which does not stop being true because they typed a different number. If
   * the pinned one cannot price the new pair the preview says so and offers "Use best".
   */
  const [pinnedRoute, setPinnedRoute] = useState<string | null>(null)
  const slippageBps = toSlippageBps(slippagePercent)

  const reserveFor = (asset: string) =>
    availableReserves.find((r) => r.underlyingAsset.toLowerCase() === asset.toLowerCase())

  /**
   * Boost is gated on BORROW POWER, not on holding any particular pair.
   *
   * The contract's ratchet path supplies a flash and repays it from a fresh borrow, so what it
   * needs is room under Aave's LTV — which is account-wide. Requiring an existing (supplied,
   * borrowed) pair would wrongly refuse an account that has supplied collateral and not yet
   * borrowed anything, which is a perfectly good thing to boost.
   */
  const borrowPowerUsd = (existingCollateralUsd * existingLtvBps) / BPS - existingDebtUsd

  /**
   * Every (supplied collateral, borrowed asset) pair the account holds — the things boost can
   * lever. Direction and subject/quote are settled here so selecting one configures the form:
   * roles must resolve to (collateral = supplied, debt = borrowed), and the label must name the
   * volatile leg, which is the one the user actually has a view on.
   */
  const positions: BoostPosition[] = useMemo(() => {
    const out: BoostPosition[] = []
    for (const supplied of suppliedAssets) {
      if (!supplied.usageAsCollateralEnabledOnUser) continue
      const coll = availableReserves.find(
        (r) => r.underlyingAsset.toLowerCase() === supplied.underlyingAsset.toLowerCase())
      if (!coll) continue
      for (const borrowed of borrowedAssets) {
        if (borrowed.underlyingAsset.toLowerCase() === supplied.underlyingAsset.toLowerCase()) continue
        const debt = availableReserves.find(
          (r) => r.underlyingAsset.toLowerCase() === borrowed.underlyingAsset.toLowerCase())
        if (!debt) continue
        // Volatile collateral means the user is long it; volatile debt means they are short it.
        const long = isVolatilePrice(Number(coll.priceInUsd))
        out.push({
          key: `${supplied.underlyingAsset}|${borrowed.underlyingAsset}`,
          label: `${long ? 'Long' : 'Short'} ${long ? coll.symbol : debt.symbol}`,
          direction: long ? 'long' : 'short',
          // `resolveRoles('long', subject, quote)` puts the subject on collateral and the short
          // case flips it, so passing the volatile leg as the subject lands the roles correctly.
          subject: long ? coll.underlyingAsset : debt.underlyingAsset,
          quote: long ? debt.underlyingAsset : coll.underlyingAsset,
        })
      }
    }
    return out
  }, [suppliedAssets, borrowedAssets, availableReserves])

  const position = positions.find((p) => p.key === positionOverride) ?? positions[0]

  // Defaults, not initial state: the reserve list arrives asynchronously, so seeding useState
  // from it would freeze whatever happened to be there on the first render. An override wins
  // once the user picks, and until then this tracks the list.
  const { subject: defaultSubject, quote: defaultQuote } = useMemo(
    () => defaultPair(availableReserves),
    [availableReserves],
  )

  // Boost needs BOTH something to lever and room to lever it: the ratchet path repays its flash
  // from a fresh borrow, so it wants headroom under Aave's LTV, which is account-wide.
  const boostDisabledReason = positions.length === 0
    ? 'Boost needs a position already open — supply collateral and borrow against it first'
    : borrowPowerUsd <= 0n
      ? 'No borrow power left to boost with — repay some debt or supply more collateral'
      : null
  // A tab the account cannot use must not stay selected if its precondition disappears
  // underneath it, so the effective tab is derived rather than trusted.
  const activeTab: LeverageTab = tab === 'boost' && boostDisabledReason ? 'long' : tab
  const boosting = activeTab === 'boost'

  const subject = boosting
    ? reserveFor(position?.subject ?? '')
    : availableReserves.find((r) => r.underlyingAsset === subjectOverride) ?? defaultSubject
  const quote = boosting
    ? reserveFor(position?.quote ?? '')
    : availableReserves.find((r) => r.underlyingAsset === quoteOverride) ?? defaultQuote

  const direction: Direction = boosting ? position?.direction ?? 'long' : activeTab

  const roles = subject && quote ? resolveRoles(direction, subject, quote) : null
  const collateralReserve = roles?.collateral
  const debtReserve = roles?.debt

  // Both legs' wallet balances, because the margin asset defaults to whichever the user actually
  // holds — the whole point of offering both entry points.
  const { data: collateralBalance } = useReadContract({
    chainId,
    address: collateralReserve?.underlyingAsset,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!collateralReserve && !boosting },
  })
  const { data: debtBalance } = useReadContract({
    chainId,
    address: debtReserve?.underlyingAsset,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!debtReserve && !boosting },
  })

  // Whichever leg the wallet holds more USD of. Derived rather than set by an effect, so it
  // tracks a balance landing late without ever overwriting a choice the user has made.
  const autoMarginAsset: MarginAsset = (() => {
    if (!collateralReserve || !debtReserve) return 'collateral'
    const collUsd = usdValue(
      (collateralBalance as bigint | undefined) ?? 0n,
      collateralReserve.raw.priceUsd, collateralReserve.raw.decimals,
    )
    const debtUsd = usdValue(
      (debtBalance as bigint | undefined) ?? 0n,
      debtReserve.raw.priceUsd, debtReserve.raw.decimals,
    )
    return debtUsd > collUsd ? 'debt' : 'collateral'
  })()
  // Boost posts nothing at all, which is what routes it to the contract's ratchet path.
  const marginAsset: MarginLocation = boosting ? 'none' : marginAssetOverride ?? autoMarginAsset

  const marginReserve = marginAsset === 'debt' ? debtReserve : collateralReserve

  // Default to sizing by the volatile leg (the subject of the position):
  // For long, the subject is the collateral. For short, the subject is the debt.
  const autoBoostDenom: 'collateral' | 'debt' = direction === 'long' ? 'collateral' : 'debt'
  const boostDenom = boostDenomOverride ?? autoBoostDenom

  /** How to format the tokens an open's receipt can name: the pair's two underlyings. */
  const outcomeTokens = useMemo(
    () => buildTokenMap([collateralReserve, debtReserve].map(toTokenSource)),
    [collateralReserve, debtReserve],
  )

  /** The aToken and variable-debt rows, which belong to the position rather than to the wallet. */
  const hiddenTokens = useMemo(
    () => positionTokens([collateralReserve, debtReserve].map(toTokenSource)),
    [collateralReserve, debtReserve],
  )
  const marginBalance = boosting
    ? 0n
    : ((marginAsset === 'debt' ? debtBalance : collateralBalance) as bigint | undefined) ?? 0n

  const marginAmount = boosting ? 0n : parseAmount(marginStr, marginReserve?.raw.decimals ?? 18)
  // Which leg the single typed amount is in. Long and short always name the supply; boost lets
  // the user say it either way, because "borrow 1 WETH" and "supply 2,000 USDC" describe the
  // same trade and different people reach for different ones.
  const sizedBy: 'supply' | 'borrow' = boosting && boostDenom === 'debt' ? 'borrow' : 'supply'
  const typedDecimals = (sizedBy === 'borrow' ? debtReserve : collateralReserve)?.raw.decimals ?? 18
  const typedAmount = parseAmount(supplyStr, typedDecimals)
  const supplyAmount = sizedBy === 'supply' ? typedAmount : 0n
  const borrowAmount = sizedBy === 'borrow' ? typedAmount : 0n

  // What the account already holds of each pair leg, for the summary's "before" column.
  const existingCollateralAmount = suppliedAssets
    .find((a) => a.underlyingAsset.toLowerCase() === collateralReserve?.underlyingAsset.toLowerCase())
    ?.amountRaw ?? 0n
  const existingDebtAmount = borrowedAssets
    .find((a) => a.underlyingAsset.toLowerCase() === debtReserve?.underlyingAsset.toLowerCase())
    ?.amountRaw ?? 0n

  // Two ceilings: the one MAX fills, and the one the danger toggle unlocks. Both fold in the
  // existing account, so an account with spare borrow power can supply more than its margin
  // alone would allow — and one already borrowed past its LTV can supply less.
  const ceilingArgs = collateralReserve && debtReserve && {
    marginAsset,
    marginAmount,
    collateralPriceUsd: collateralReserve.raw.priceUsd,
    debtPriceUsd: debtReserve.raw.priceUsd,
    collateralDecimals: collateralReserve.raw.decimals,
    debtDecimals: debtReserve.raw.decimals,
    ltvBps: collateralReserve.raw.ltvBps,
    liquidationThresholdBps: collateralReserve.raw.liquidationThresholdBps,
    existingCollateralUsd,
    existingDebtUsd,
    existingLtvBps,
    existingLiquidationThresholdBps,
  }
  // In whichever unit the amount is typed, so MAX fills the field directly.
  const capIn = sizedBy === 'borrow' ? maxBorrowAmount : maxSupplyAmount
  const safeMax = ceilingArgs ? capIn({ ...ceilingArgs, danger: false }) : 0n
  const dangerMax = ceilingArgs ? capIn({ ...ceilingArgs, danger: true }) : 0n
  const maxSupply = danger ? dangerMax : safeMax

  // On the borrow path the flash is whatever the swap returns, which only a route can say — the
  // estimate below stands in until one does.
  const { flashAmount: supplyFlash } = deriveOpen({ marginAsset, marginAmount, supplyAmount })
  const estimatedSwapOut = collateralReserve && debtReserve && borrowAmount > 0n
    ? (borrowAmount * debtReserve.raw.priceUsd * 10n ** BigInt(collateralReserve.raw.decimals)
      * (BPS - slippageBps))
    / (collateralReserve.raw.priceUsd * 10n ** BigInt(debtReserve.raw.decimals) * BPS)
    : 0n
  const flashAmount = sizedBy === 'borrow' ? estimatedSwapOut : supplyFlash

  // The borrow shown while typing: the oracle's estimate, which is the same figure `solveBorrow`
  // seeds from. It firms up when the route answers rather than appearing from nothing.
  const seededBorrow = sizedBy === 'borrow'
    ? borrowAmount
    : collateralReserve && debtReserve && flashAmount > 0n
      ? seedBorrow({
        flashAmount,
        debtMargin: marginAsset === 'debt' ? marginAmount : 0n,
        slipNum: BPS - slippageBps,
        collateralPriceUsd: collateralReserve.raw.priceUsd,
        debtPriceUsd: debtReserve.raw.priceUsd,
        collateralDecimals: collateralReserve.raw.decimals,
        debtDecimals: debtReserve.raw.decimals,
      })
      : null

  /**
   * Whether Aave will actually count this supply toward the user's borrow power.
   *
   * Supplying and collateralising are not the same thing — see `collateralEnablement`. Null
   * until the reserve resolves, which `validateSizing` reads as "unknown, don't block": a
   * missing read must never gate the form.
   */
  const enablement = collateralReserve
    ? collateralEnablement({
      scaledATokenBalance:
        collateralFlags[collateralReserve.underlyingAsset.toLowerCase()]?.scaledATokenBalance ?? 0n,
      enabledOnUser:
        collateralFlags[collateralReserve.underlyingAsset.toLowerCase()]?.enabledOnUser ?? false,
      usageAsCollateralEnabled: collateralReserve.raw.usageAsCollateralEnabled,
      ltvBps: collateralReserve.raw.ltvBps,
      debtCeiling: collateralReserve.raw.debtCeiling,
      eModeExcluded:
        eModeExcludedReserves[collateralReserve.underlyingAsset.toLowerCase()] ?? false,
      hasOtherCollateral: hasAnyCollateralEnabled,
    })
    : null

  // What the position becomes, at oracle prices, before any router is asked. Costs no network
  // call, so every "after" figure is readable from the first keystroke instead of appearing only
  // once a quote settles. `expectedSwapOut` is the flash itself: at oracle prices the swap repays
  // it exactly, which makes the supplied collateral come out as the supply the user typed.
  const estimate = collateralReserve && debtReserve && seededBorrow !== null && flashAmount > 0n
    ? projectOpen({
      marginAsset,
      marginAmount,
      borrowAmount: seededBorrow,
      expectedSwapOut: flashAmount,
      collateralPriceUsd: collateralReserve.raw.priceUsd,
      debtPriceUsd: debtReserve.raw.priceUsd,
      collateralDecimals: collateralReserve.raw.decimals,
      debtDecimals: debtReserve.raw.decimals,
      // Zeroed when Aave will not count this reserve: `calculateUserAccountData` skips such a
      // supply entirely, so blending its own LTV in would show a health factor and liquidation
      // price the account is not actually going to have.
      ltvBps: enablement && !enablement.willCount ? 0n : collateralReserve.raw.ltvBps,
      liquidationThresholdBps:
        enablement && !enablement.willCount ? 0n : collateralReserve.raw.liquidationThresholdBps,
      existingCollateralUsd,
      existingDebtUsd,
      existingLtvBps,
      existingLiquidationThresholdBps,
    })
    : null

  // Checked here as well as inside the hook, and for a different reason: this is instant, and it
  // gates `input` to null so a form that cannot possibly open never spends a quote.
  const sizingError = validateSizing({
    marginAsset, marginAmount, supplyAmount: typedAmount, marginBalance, maxSupply,
    collateral: enablement,
    // Only the reserves are missing before the read lands, and a null degrades to "don't check"
    // rather than to a blocked form.
    pricing: collateralReserve && debtReserve
      ? {
        slipNum: BPS - slippageBps,
        collateralPriceUsd: collateralReserve.raw.priceUsd,
        debtPriceUsd: debtReserve.raw.priceUsd,
        collateralDecimals: collateralReserve.raw.decimals,
        debtDecimals: debtReserve.raw.decimals,
      }
      : null,
  })

  /**
   * Rebuilt on every render, and not memoized. That is safe ONLY because `useLeverageOpen` keys
   * its quoting effect on `inputKey(input)` — the values — rather than on this object's identity.
   *
   * It was not always: the effect depended on the object, so every render re-quoted, and each
   * finished quote re-rendered this component, which re-quoted. Do not hand this object to
   * anything that compares by identity without checking what that does.
   */
  const input = (() => {
    if (!contract || !subject || !quote || !collateralReserve || !debtReserve) return null
    if (subject.underlyingAsset === quote.underlyingAsset) return null
    if (sizingError) return null
    return {
      contract,
      direction,
      marginAsset,
      subject: subject.underlyingAsset,
      quote: quote.underlyingAsset,
      marginAmount,
      sizedBy,
      supplyAmount,
      borrowAmount,
      maxSupply,
      slippageBps,
      marginBalance,
      existingCollateralUsd,
      existingDebtUsd,
      existingLtvBps,
      existingLiquidationThresholdBps,
      collateralEnablement: enablement,
      preferredAggregator: pinnedRoute ?? undefined,
      reserves: {
        collateral: {
          address: collateralReserve.underlyingAsset, symbol: collateralReserve.symbol,
          ...collateralReserve.raw,
        },
        debt: {
          address: debtReserve.underlyingAsset, symbol: debtReserve.symbol,
          ...debtReserve.raw,
        },
      },
    }
  })()

  /**
   * The pair the confirmation was opened against, FROZEN at that moment.
   *
   * The modal used to be mounted on `confirming && collateralReserve && debtReserve`, and both
   * reserves are derived from `useAavePositions` data that refetches. Any refetch that briefly
   * emptied the reserve list therefore unmounted the modal mid-transaction — and on the boost path
   * that is not a rare race but the ordinary sequence, because a successful open CHANGES the
   * position and provokes exactly that refetch, at the same moment the receipt lands. The settled
   * report was being destroyed as it was written.
   *
   * A snapshot instead. Everything the modal must keep fresh — the route, the projection, the
   * quoting flag — is still passed live; only its right to exist stops depending on a refetch.
   */
  /** Guards the Open press against a second click landing before `step` catches up. */
  const pressing = useRef(false)

  const [confirming, setConfirming] = useState<{
    collateral: AvailableReserve
    debt: AvailableReserve
  } | null>(null)

  const {
    preview, previewError, rejected, routes, isQuoting, prepare, submit, step, execError, execRemedy, settleNote, txHash, refresh, hardRefresh, outcome,
    reusableSignature, pinnedBorrow, forgetSignature, reset,
    approve,
  } = useLeverageOpen(input, undefined, {
    // The panel prices nothing. Quoting starts when the confirmation opens and stops with it,
    // so the form costs no aggregator calls however long someone sits typing in it.
    paused: !confirming || active === false || !tabVisible,
  })

  // Filed here rather than in the hook: this is the layer that knows the symbols and decimals,
  // and an entry without those is unreadable by the time anyone comes back to look at it.
  // Filtered once, so the panel and the history row report the same thing.
  const settled = useMemo(() => hideTokens(outcome, hiddenTokens), [outcome, hiddenTokens])

  useRecordOutcome({
    outcome: settled, tokens: outcomeTokens, hash: txHash, chainId, wallet: address, kind: 'open',
  })

  /**
   * Whether the confirmation modal is up.
   *
   * The Open button no longer needs a live preview to be pressable, which is half the fix: the
   * panel's quote goes stale on every background refresh of prices and balances, so gating the
   * button on one left it disabled at exactly the moments a user reaches for it. Pressing it now
   * opens the modal, and the modal is what waits for a route.
   */
  // Someone else's portfolio is read-only. An undeployed contract does NOT hide the panel: it is
  // how the feature is discovered, and hiding it makes it look absent rather than unavailable.
  // Nothing can be signed without an address — `input` stays null, so Open stays disabled.
  if (viewAddress) return null

  const paused = previewError === 'PAUSED'
  /**
   * A form nobody has typed into yet has no mistake in it to report.
   *
   * NO_MARGIN and NO_SUPPLY are prompts rather than errors — they only ever mean "you have not
   * filled this in". Rendered in red on a freshly loaded page they read as something already
   * being wrong, before the user has done anything at all. Suppressed only while BOTH boxes are
   * untouched: once either is filled, the prompt is what says which one is still missing.
   */
  const pristine = marginStr === '' && supplyStr === ''
  const unTyped = sizingError === 'NO_MARGIN' || sizingError === 'NO_SUPPLY'
  const errorCode = (pristine && unTyped ? null : sizingError) ?? (paused ? null : previewError)
  // The floor a debt-asset margin puts under the supply, said in the asset the supply is typed
  // in. A collateral margin is already in those units, so there is nothing to convert.
  const marginWorth =
    marginAsset === 'debt' && collateralReserve && debtReserve && collateralReserve.raw.priceUsd > 0n
      ? display(
        (marginAmount * debtReserve.raw.priceUsd * 10n ** BigInt(collateralReserve.raw.decimals))
        / (collateralReserve.raw.priceUsd * 10n ** BigInt(debtReserve.raw.decimals)),
        collateralReserve.raw.decimals,
        4,
      )
      : null
  const message = errorCode && collateralReserve && marginReserve
    ? leverageErrorMessage(errorCode, {
      collateralSymbol: collateralReserve.symbol,
      marginSymbol: marginReserve.symbol,
      marginBalance: display(marginBalance, marginReserve.raw.decimals, 4),
      maxSupply: display(safeMax, collateralReserve.raw.decimals, 4),
      dangerMaxSupply: danger || dangerMax <= safeMax
        ? null
        : display(dangerMax, collateralReserve.raw.decimals, 4),
      marginWorth,
      rejected,
      pinnedAggregator: pinnedRoute ?? undefined,
      collateral: enablement,
    })
    : null

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

  // Picking an asset that is already on the other side swaps the two rather than rejecting —
  // the contract reverts on a same-asset pair, and a silently broken form is worse than a swap.
  const pickSubject = (next: `0x${string}`) => {
    if (next === quote?.underlyingAsset) setQuoteOverride(subject?.underlyingAsset ?? null)
    setSubjectOverride(next)
  }
  const pickQuote = (next: `0x${string}`) => {
    if (next === subject?.underlyingAsset) setSubjectOverride(quote?.underlyingAsset ?? null)
    setQuoteOverride(next)
  }
  // What the account holds on the selected position, for context under the picker.
  const positionNote = boosting && collateralReserve && debtReserve
    ? `You hold ${display(existingCollateralAmount, collateralReserve.raw.decimals, 4)} ${collateralReserve.symbol} supplied · ${display(existingDebtAmount, debtReserve.raw.decimals, 4)} ${debtReserve.symbol} borrowed`
    : null

  const marginChoices = collateralReserve && debtReserve
    ? [
      { value: 'collateral', label: collateralReserve.symbol },
      { value: 'debt', label: debtReserve.symbol },
    ]
    : []

  const actionLabel = boosting ? `Boost ${direction} ${subject?.symbol ?? ''}` : `Open ${direction} ${subject?.symbol ?? ''}`

  return (
    // `.card` rather than inline chrome, so this sits at the same width and carries the same
    // surface, border and shadow as the Supplied/Borrowed Assets cards it shares a column with.
    <div className="card">
      {/* Two columns once there is room for them — what you enter on the left, what it becomes on
          the right — collapsing to one on a narrow viewport. At full card width a single column
          would leave the inputs stretched across the page with the summary far below the fold. */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        gap: T.space[5], alignItems: 'start',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: T.space[4] }}>
          <PairPicker
            tab={activeTab}
            onTabChange={setTab}
            boostDisabledReason={boostDisabledReason}
            options={availableReserves.map((r) => ({ address: r.underlyingAsset, symbol: r.symbol }))}
            subject={subject?.underlyingAsset}
            quote={quote?.underlyingAsset}
            onSubjectChange={pickSubject}
            onQuoteChange={pickQuote}
            positions={positions}
            selectedPosition={position?.key}
            onPositionChange={setPositionOverride}
            positionNote={positionNote}
          />

          <div style={{ fontSize: T.fontSize.sm, color: T.textMuted }}>
            {boosting
              ? `Borrow ${debtReserve?.symbol ?? '—'} → Swap → Supply ${collateralReserve?.symbol ?? '—'}, in one transaction.`
              : `Collateral ${collateralReserve?.symbol ?? '—'} · Borrow ${debtReserve?.symbol ?? '—'}${collateralReserve ? ` · LTV ${(Number(collateralReserve.raw.ltvBps) / 100).toFixed(0)}%` : ''}`}
          </div>

          {paused && (
            <div style={{ padding: T.space[2], borderRadius: T.radius.md, background: T.warningBg, color: T.warning, fontSize: T.fontSize.sm }}>
              Leverage is paused.
            </div>
          )}

          {/* `contract` null gates `input` to null, which keeps `preview` null, which leaves Open
              disabled no matter what is typed. Every other disabling condition says why — this one
              said nothing, so the panel read as ready and the button read as broken. */}
          {!contract && (
            <div style={{ padding: T.space[2], borderRadius: T.radius.md, background: T.warningBg, color: T.warning, fontSize: T.fontSize.sm }}>
              Leverage is not deployed on this network yet.
            </div>
          )}

          {/* Boost posts no margin by design — the contract's ratchet path takes none, and the
              ceiling comes from the account's own borrow power instead. */}
          {!boosting && (
            <AmountField
              label="Margin"
              value={marginStr}
              onChange={setMarginStr}
              symbol={marginReserve?.symbol ?? '—'}
              choices={marginChoices}
              selected={marginAsset}
              onSelect={(next) => setMarginAssetOverride(next as MarginAsset)}
              max={marginBalance > 0n ? formatUnits(marginBalance, marginReserve?.raw.decimals ?? 18) : null}
              hint={`Balance ${display(marginBalance, marginReserve?.raw.decimals ?? 18, 4)} ${marginReserve?.symbol ?? ''}`}
            />
          )}

          {/* One field, two denominations. Boost lets the user name either leg — the label
              follows the chosen asset so "Add to borrow / WETH" and "Add to supply / USDC" each read
              as one sentence rather than a number next to an unexplained dropdown. */}
          <AmountField
            label={boosting ? (sizedBy === 'borrow' ? 'Add to borrow' : 'Add to supply') : 'Supply to Aave'}
            value={supplyStr}
            onChange={setSupplyStr}
            symbol={(sizedBy === 'borrow' ? debtReserve : collateralReserve)?.symbol ?? '—'}
            choices={boosting ? marginChoices : undefined}
            selected={boosting ? boostDenom : undefined}
            onSelect={boosting ? (next) => setBoostDenomOverride(next as 'collateral' | 'debt') : undefined}
            max={maxSupply > 0n ? formatUnits(maxSupply, typedDecimals) : null}
            hint={maxSupply > 0n
              ? `Max ${display(maxSupply, typedDecimals, 4)} ${(sizedBy === 'borrow' ? debtReserve : collateralReserve)?.symbol ?? ''}${boosting ? ' from your borrow power' : ''}`
              : boosting
                ? 'No borrow power left to boost with'
                : 'Enter a margin to see how much you can supply'}
          />

          {/* The gap between the route's expected output and the floor the contract enforces —
              so it belongs next to the amounts that determine both, not behind a settings menu.
              Widening it accepts a worse fill; tightening it risks the open reverting outright. */}
          <SlippageField
            percent={slippagePercent}
            onChange={setSlippagePercent}
            ariaLabel="Max slippage percent"
          />

          {dangerMax > safeMax && (
            <label style={{ display: 'flex', alignItems: 'center', gap: T.space[2], fontSize: T.fontSize.sm, color: T.textMuted, cursor: 'pointer' }}>
              <input type="checkbox" checked={danger} onChange={(e) => setDanger(e.target.checked)} />
              Danger zone — supply up to{' '}
              {display(dangerMax, collateralReserve?.raw.decimals ?? 18, 4)} {collateralReserve?.symbol},
              leaving almost no room before liquidation
            </label>
          )}

          {message && (
            <div style={{ fontSize: T.fontSize.sm, color: T.danger }}>{message}</div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: T.space[3] }}>
          <PositionSummary
            preview={preview}
            // The router-verified projection the moment there is one; the oracle estimate until then.
            projection={preview?.projection ?? estimate}
            isEstimate={!preview}
            direction={direction}
            subjectSymbol={subject?.symbol ?? '—'}
            flashAmount={flashAmount > 0n ? flashAmount : 0n}
            collateralSymbol={collateralReserve?.symbol ?? '—'}
            debtSymbol={debtReserve?.symbol ?? '—'}
            collateralDecimals={collateralReserve?.raw.decimals ?? 18}
            debtDecimals={debtReserve?.raw.decimals ?? 18}
            collateralPriceUsd={Number(collateralReserve?.priceInUsd ?? 0)}
            debtPriceUsd={Number(debtReserve?.priceInUsd ?? 0)}
            liquidationThreshold={collateralReserve?.liquidationThreshold ?? 0}
            existingCollateral={toCollateralInputs(suppliedAssets)}
            existingCollateralUsd={existingCollateralUsd}
            existingDebtUsd={existingDebtUsd}
            existingLtvBps={existingLtvBps}
            existingLiquidationThresholdBps={existingLiquidationThresholdBps}
            existingCollateralAmount={existingCollateralAmount}
            existingDebtAmount={existingDebtAmount}
          />

          {/* The route picker, the built figures, the price-impact block and the re-price
              button all moved to the confirmation. Every one of them reads a quote, and the panel
              takes none — the estimate column on the right is oracle-priced and needs none. */}

          {/* Still all three, because the sequence is what the user is being told. Only the
              first happens here now; the other two are the confirmation's. */}
          <div style={{ fontSize: T.fontSize.sm, color: T.textMuted }}>
            {(['approving', 'signing', 'sending'] as const).map((s, i) => (
              <span key={s} style={{ fontWeight: step === s ? 700 : 400, color: step === s ? T.text : T.textMuted }}>
                {i > 0 && ' · '}
                {s === 'approving' ? 'approve' : s === 'signing' ? 'sign' : 'send'}
              </span>
            ))}
          </div>

          {/* Never waits on a quote, because there is none here to wait for. The margin token and
              the amount both come from the form, so the allowance is answerable immediately. */}
          <button
            onClick={() => {
              // The previous attempt's hash, error and authorisation belong to the previous
              // attempt.
              reset()
              // `approve` awaits a pause read before it sets `step`, so `busy` has not caught up
              // yet and a fast second click would land in that window and prompt the wallet
              // twice. A ref, because it has to take effect inside the same tick.
              if (pressing.current) return
              pressing.current = true
              void (async () => {
                // Opens the confirmation on the RETURN value, not on `step`: state cannot be read
                // back inside the same tick. A refusal leaves the user here, where the error
                // renders under the button they just pressed.
                const approved = await approve()
                pressing.current = false
                if (approved && collateralReserve && debtReserve) {
                  setConfirming({ collateral: collateralReserve, debt: debtReserve })
                }
              })()
            }}
            disabled={!input || busy}
            style={{
              padding: T.space[3], borderRadius: T.radius.md, border: 'none', cursor: 'pointer',
              background: !input || busy ? T.border : T.primary,
              color: '#fff', fontWeight: 600,
            }}
          >
            {step === 'approving' ? 'Check your wallet…' : actionLabel}
          </button>

          {/* Errors from an attempt made in the modal stay visible after it closes — the modal is
              where they are raised, but the panel is where the user ends up. */}
          {!confirming && execError && (
            <div style={{ fontSize: T.fontSize.sm, color: T.danger }}>
              {execError}
              {remedyHint && <span style={{ color: T.textMuted }}> {remedyHint}</span>}
              {' '}
              {/* Also a press, so also past the reuse window: retrying against the same cached
                  quote that just failed is the one thing this button must not do. */}
              <button
                onClick={hardRefresh}
                style={{
                  border: 'none', background: 'none', padding: 0, cursor: 'pointer',
                  color: T.primary, fontWeight: 600, fontSize: T.fontSize.sm,
                }}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      </div>

      {confirming && (
        <ConfirmLeverageModal
          title={actionLabel}
          routes={routes.map((q) => ({
            aggregator: q.aggregator,
            amountOut: display(BigInt(q.amountOut), confirming.collateral.raw.decimals, 4),
          }))}
          pinnedRoute={pinnedRoute}
          onPinRoute={setPinnedRoute}
          marginLine={boosting || !marginReserve
            ? null
            : `${display(marginAmount, marginReserve.raw.decimals, 6)} ${marginReserve.symbol}`}
          // What the position gains, taken from the route when there is one and from the typed
          // figure until then, so the line never reads as zero while a quote is in flight.
          supplyLine={`${display(
            preview?.projection.expectedCollateral ?? estimate?.expectedCollateral ?? supplyAmount,
            confirming.collateral.raw.decimals, 6,
          )} ${confirming.collateral.symbol}`}
          borrowLine={`${display(
            preview?.borrowAmount ?? seededBorrow ?? 0n, confirming.debt.raw.decimals, 6,
          )} ${confirming.debt.symbol}`}
          preview={preview}
          projection={preview?.projection ?? estimate}
          isQuoting={isQuoting}
          previewMessage={message}
          // A moved route can only be waited out when the borrow is free to re-solve; pinned, it
          // is the held signature that has to give.
          showResign={pinnedBorrow !== null && previewError === 'QUOTE_MOVED'}
          priceImpactBlocked={priceImpactBlocked}
          slippageBps={slippageBps}
          slippagePercent={slippagePercent}
          onSlippageChange={setSlippagePercent}
          collateralSymbol={confirming.collateral.symbol}
          debtSymbol={confirming.debt.symbol}
          collateralDecimals={confirming.collateral.raw.decimals}
          debtDecimals={confirming.debt.raw.decimals}
          step={step}
          execError={execError}
          settleNote={settleNote}
          remedyHint={remedyHint}
          txHash={txHash}
          chainId={chainId}
          outcome={settled}
          outcomeTokens={outcomeTokens}
          reusableSignature={reusableSignature}
          onRefresh={refresh}
          onHardRefresh={hardRefresh}
          onResign={forgetSignature}
          onConfirm={() => void (async () => {
            // Sign THEN send. The delegation commits to one exact borrow, so it can only be
            // taken once a route has solved one — which happens here, not on the panel.
            if (await prepare()) await submit()
          })()}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  )
}
