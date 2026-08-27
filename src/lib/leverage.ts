/**
 * The whole sizing model for opening a leveraged position.
 *
 * The user enters two amounts — a MARGIN they post from the wallet, and a SUPPLY they want
 * landing in the pool. Everything else (flash, borrow, leverage) is derived. The borrow in
 * particular is never typed: `solveBorrow` derives it from the flash it has to repay, so no
 * reachable combination of inputs produces a swap that comes up short.
 *
 * Pure. No React, no network, no config.
 */
import { BPS, LTV_CEILING_FACTOR_BPS } from "./strategies-sdk/sizing";
import type { MarginIn, MarginLocation } from "./strategies-sdk/sizing";
import type { OpenMode } from "./strategies-sdk/plan";
import { seedBorrow } from "./solveBorrow";
import type { SeedBorrowPricing } from "./solveBorrow";

/** Which side of the pair the user is taking. Longs collateralize it; shorts borrow it. */
export type Direction = "long" | "short";

/**
 * Which of the two pair assets the margin arrives in. This picks the contract entry point:
 * `collateral` → `openWithCollateralMargin` (margin joins the flash in one supply),
 * `debt` → `openWithDebtMargin` (margin joins the borrow inside the swap).
 */
export type MarginAsset = MarginIn;

/**
 * The same, widened with the BOOST path: `none` posts no margin at all and levers whatever the
 * account already has. It takes the collateral entry point with a zero margin.
 */
export type { MarginLocation };

/**
 * The health factor the MAX button is built around.
 *
 * The theoretical ceiling — leverage 1/(1 − LTV) — lands at a health factor of
 * `liquidationThreshold / LTV`, which for a typical 80/82.5 reserve is 1.03. That is a position
 * a 3% adverse move liquidates. So MAX targets this instead, and the true ceiling is an explicit
 * opt-in rather than the default.
 */
const SAFE_TARGET_HF_BPS = 11_500n;

function pow10(n: number | bigint): bigint {
  return 10n ** BigInt(n);
}

/** Value of `amount` in 8dp USD, given an 8dp Aave oracle price. */
export function usdValue(amount: bigint, priceUsd: bigint, decimals: number): bigint {
  return (amount * priceUsd) / pow10(decimals);
}

/**
 * Which UX mode the SDK should plan against.
 *
 * `resolveMode` in the SDK maps these back onto (collateral, debtAsset, marginIn), so this is
 * the one place the direction/margin pair is turned into the SDK's vocabulary. Modes 5 and 6
 * are the BOOST path — no margin at all, levering an existing position rather than new equity.
 */
export function resolveOpenMode(direction: Direction, marginAsset: MarginLocation): OpenMode {
  if (marginAsset === "none") return direction === "long" ? 5 : 6;
  if (direction === "long") return marginAsset === "collateral" ? 1 : 2;
  return marginAsset === "collateral" ? 4 : 3;
}

/** Which of the two reserves plays collateral, and which plays debt. */
export function resolveRoles<T>(direction: Direction, subject: T, quote: T): { collateral: T; debt: T } {
  return direction === "long" ? { collateral: subject, debt: quote } : { collateral: quote, debt: subject };
}

/**
 * Aave's LTV wall for a reserve, with the SDK's haircut. Past it the borrow itself reverts.
 *
 * Returns 0n for a reserve that cannot be levered at all (zero LTV — a borrow-only asset), which
 * leaves {@link maxSupplyAmount} with nothing to lever.
 */
export function ltvWallBps(ltvBps: bigint): bigint {
  if (ltvBps <= 0n) return 0n;
  return (ltvBps * LTV_CEILING_FACTOR_BPS) / BPS;
}

interface MaxSupplyInput {
  marginAsset: MarginLocation;
  marginAmount: bigint;
  /** Aave 8dp oracle prices and native decimals for both legs. */
  collateralPriceUsd: bigint;
  debtPriceUsd: bigint;
  collateralDecimals: number;
  debtDecimals: number;
  /** The NEW collateral reserve's own parameters, in bps. */
  ltvBps: bigint;
  liquidationThresholdBps: bigint;
  /** `getUserAccountData` totals, 8dp USD, and that account's weighted parameters in bps. */
  existingCollateralUsd: bigint;
  existingDebtUsd: bigint;
  existingLtvBps: bigint;
  existingLiquidationThresholdBps: bigint;
  /** True once the user has opted past the health-factor cap, up to the LTV wall. */
  danger: boolean;
}

/** The margin's value in 8dp USD, whichever leg it is posted in. Zero on the boost path. */
function marginValueUsd(p: MaxSupplyInput): bigint {
  if (p.marginAsset === "none") return 0n;
  return p.marginAsset === "debt"
    ? usdValue(p.marginAmount, p.debtPriceUsd, p.debtDecimals)
    : usdValue(p.marginAmount, p.collateralPriceUsd, p.collateralDecimals);
}

/**
 * The largest supply this account can reach, in COLLATERAL wei.
 *
 * Two constraints bind, and the answer is whichever is tighter.
 *
 * **Aave's LTV wall.** Aave checks the new debt against the SUM of each reserve's own borrow
 * power, not against any single reserve's LTV. With `M` the margin, `C₀`/`D₀` the existing
 * account and `L` the new collateral's LTV, `D₀ + (S − M) ≤ C₀L₀ + S·L` gives
 *
 *     S ≤ (M + C₀L₀ − D₀) / (1 − L)
 *
 * where `C₀L₀ − D₀` is exactly the borrow power the account has left. Both entry points collapse
 * into this: margin posted as collateral makes the borrow `S − M`, and margin posted as debt
 * makes it `S·Pc − M_usd` — the same thing in USD. It is also the closed form of the
 * supply/borrow/re-supply loop, since looping n times supplies `M(1−Lⁿ)/(1−L)`.
 *
 * **The health-factor target.** Solving `(C₀·LT₀ + S·LT) ≥ HF·(D₀ + S − M)` for S:
 *
 *     S ≤ (C₀·LT₀ + HF·M − HF·D₀) / (HF − LT)
 *
 * On an empty account this reduces to `M/(1 − LT/HF)`, which is the same thing as applying the
 * wall formula at an LTV of `LT/HF` — the two agree, and only diverge once there is an existing
 * position whose own threshold differs from the incoming reserve's.
 *
 * `danger` drops the second constraint, leaving Aave's wall alone.
 *
 * Zero margin is the BOOST path: the numerators collapse to the existing account's own headroom,
 * so an account with borrow power to spare can still supply, and one without gets 0n.
 */
export function maxSupplyAmount(p: MaxSupplyInput): bigint {
  const ceiling = maxSupplyUsd(p);
  if (ceiling <= 0n) return 0n;
  return (ceiling * pow10(p.collateralDecimals)) / p.collateralPriceUsd;
}

/**
 * The same ceiling in DEBT wei — what the boost path's borrow-denominated entry is capped at.
 *
 * Only meaningful on that path, and exact there: boost supplies every unit it borrows, so the
 * supply and the borrow are the same USD figure and one ceiling serves both. On a margin path
 * they diverge by the margin and this would overstate the borrow.
 */
export function maxBorrowAmount(p: MaxSupplyInput): bigint {
  if (p.marginAsset !== "none") return 0n;
  const ceiling = maxSupplyUsd(p);
  if (ceiling <= 0n) return 0n;
  return (ceiling * pow10(p.debtDecimals)) / p.debtPriceUsd;
}

/** The ceiling in 8dp USD, before it is denominated in either leg. See {@link maxSupplyAmount}. */
function maxSupplyUsd(p: MaxSupplyInput): bigint {
  if (p.collateralPriceUsd <= 0n || p.debtPriceUsd <= 0n) return 0n;

  const margin = marginValueUsd(p);
  const existingBorrowPowerUsd =
    (p.existingCollateralUsd * p.existingLtvBps) / BPS - p.existingDebtUsd;

  // Aave's wall.
  const wallBps = ltvWallBps(p.ltvBps);
  if (wallBps >= BPS) return 0n;
  const wallNumerator = margin + existingBorrowPowerUsd;
  if (wallNumerator <= 0n) return 0n;
  const wallMax = (wallNumerator * BPS) / (BPS - wallBps);
  if (p.danger) return wallMax;

  // The health-factor target. A threshold at or above the target would mean any amount of this
  // collateral holds it, so the wall is the only bound left.
  if (p.liquidationThresholdBps >= SAFE_TARGET_HF_BPS) return wallMax;
  const hfNumerator =
    (p.existingCollateralUsd * p.existingLiquidationThresholdBps) / BPS +
    (SAFE_TARGET_HF_BPS * (margin - p.existingDebtUsd)) / BPS;
  if (hfNumerator <= 0n) return 0n;
  const hfMax = (hfNumerator * BPS) / (SAFE_TARGET_HF_BPS - p.liquidationThresholdBps);

  return hfMax < wallMax ? hfMax : wallMax;
}

interface DeriveOpenInput {
  marginAsset: MarginLocation;
  marginAmount: bigint;
  /** What the user wants landing in the pool, in COLLATERAL wei. */
  supplyAmount: bigint;
}

interface DerivedAmounts {
  /**
   * Flash-borrowed from Morpho, always in the COLLATERAL asset.
   *
   * On the collateral path the margin is supplied alongside the flash
   * (AaveV3Strategies.sol:480-481), so it reduces the flash one-for-one. On the debt path the
   * margin goes into the swap instead (:491), so the flash IS the whole supply.
   */
  flashAmount: bigint;
  /** The part of the swap input the user brought themselves. Zero on the collateral path. */
  debtMargin: bigint;
}

export function deriveOpen(p: DeriveOpenInput): DerivedAmounts {
  // "none" (boost) rides the collateral branch with a zero margin, which is exactly what the
  // contract does: `planOpen` routes it to `openWithCollateralMargin` and the flash alone
  // becomes the supply — AaveV3Strategies.sol:334.
  return p.marginAsset !== "debt"
    ? { flashAmount: p.supplyAmount - p.marginAmount, debtMargin: 0n }
    : { flashAmount: p.supplyAmount, debtMargin: p.marginAmount };
}

interface LeverageReadoutInput {
  marginAsset: MarginLocation;
  marginAmount: bigint;
  supplyAmount: bigint;
  collateralPriceUsd: bigint;
  debtPriceUsd: bigint;
  collateralDecimals: number;
  debtDecimals: number;
}

/**
 * Supply value over margin value, in bps — the multiplier the user is actually taking.
 *
 * A readout, never an input. Null when the margin has no value to divide by.
 */
export function leverageReadoutBps(p: LeverageReadoutInput): bigint | null {
  // Zero on the boost path, where no equity is added and the ratio would say nothing.
  const marginUsd =
    p.marginAsset === "debt"
      ? usdValue(p.marginAmount, p.debtPriceUsd, p.debtDecimals)
      : usdValue(p.marginAmount, p.collateralPriceUsd, p.collateralDecimals);
  if (marginUsd <= 0n) return null;
  const supplyValueUsd = usdValue(p.supplyAmount, p.collateralPriceUsd, p.collateralDecimals);
  return (supplyValueUsd * BPS) / marginUsd;
}

/**
 * Aave judges a borrow, and a liquidation, against the COLLATERAL-WEIGHTED AVERAGE of every
 * supplied reserve's parameters — not the incoming reserve's own. Applying the new reserve's own
 * `ltvBps` to account-wide totals rejects positions Aave would accept (existing collateral
 * looser, or eMode on) and — the expensive direction — accepts borrows Aave reverts, leaving the
 * user to pay the gas.
 *
 * `existingBps` arrives already weighted across the account, so weighting the two sides by USD
 * value is the whole calculation. With nothing supplied this reduces to `newBps`.
 */
function blendAccountBps(existingUsd: bigint, existingBps: bigint, newUsd: bigint, newBps: bigint): bigint {
  const total = existingUsd + newUsd;
  if (total <= 0n) return newBps;
  return (existingUsd * existingBps + newUsd * newBps) / total;
}

interface ProjectOpenInput {
  marginAsset: MarginLocation;
  marginAmount: bigint;
  /** Solved against the router, not typed. */
  borrowAmount: bigint;
  /** What the swap is expected to return, in collateral wei. 0n before a quote lands. */
  expectedSwapOut: bigint;
  collateralPriceUsd: bigint;
  debtPriceUsd: bigint;
  collateralDecimals: number;
  debtDecimals: number;
  /** The NEW collateral reserve's own parameters. */
  ltvBps: bigint;
  liquidationThresholdBps: bigint;
  /** `getUserAccountData` totals, 8dp USD — the account this lands on top of. */
  existingCollateralUsd: bigint;
  existingDebtUsd: bigint;
  /** That account's collateral-weighted LTV and threshold, bps, eMode already baked in. */
  existingLtvBps: bigint;
  existingLiquidationThresholdBps: bigint;
}

export interface OpenProjection {
  expectedCollateral: bigint;
  expectedDebt: bigint;
  /** Account-wide 8dp USD totals the position would leave behind, existing holdings included. */
  totalCollateralUsd: bigint;
  totalDebtUsd: bigint;
  expectedLeverageBps: bigint | null;
  expectedHealthFactorBps: bigint;
  impliedLtvBps: bigint;
  /** The account-wide LTV ceiling `impliedLtvBps` has to clear. */
  avgLtvBps: bigint;
  /**
   * The collateral-weighted liquidation threshold the resulting ACCOUNT would carry — what Aave
   * actually liquidates against, and what a liquidation price has to be solved at.
   */
  avgLiquidationThresholdBps: bigint;
}

/** What the account looks like once this opens. Account-wide, because that is what Aave judges. */
export function projectOpen(p: ProjectOpenInput): OpenProjection {
  // The collateral path supplies flash + margin and the swap output repays the flash, leaving
  // the surplus in the position. The debt path supplies the flash alone and the whole output
  // lands as collateral — the margin is already inside it. AaveV3Strategies.sol:479-491.
  const expectedCollateral =
    p.marginAsset === "debt" ? p.expectedSwapOut : p.marginAmount + p.expectedSwapOut;

  const newCollUsd = usdValue(expectedCollateral, p.collateralPriceUsd, p.collateralDecimals);
  const collUsd = newCollUsd + p.existingCollateralUsd;
  const debtUsd = usdValue(p.borrowAmount, p.debtPriceUsd, p.debtDecimals) + p.existingDebtUsd;
  const equityUsd = collUsd - debtUsd;

  const avgLtvBps = blendAccountBps(p.existingCollateralUsd, p.existingLtvBps, newCollUsd, p.ltvBps);
  const avgLiquidationThresholdBps = blendAccountBps(
    p.existingCollateralUsd,
    p.existingLiquidationThresholdBps,
    newCollUsd,
    p.liquidationThresholdBps,
  );

  return {
    expectedCollateral,
    expectedDebt: p.borrowAmount,
    totalCollateralUsd: collUsd,
    totalDebtUsd: debtUsd,
    expectedLeverageBps: equityUsd <= 0n ? null : (collUsd * BPS) / equityUsd,
    expectedHealthFactorBps: debtUsd > 0n ? (collUsd * avgLiquidationThresholdBps) / debtUsd : 0n,
    impliedLtvBps: collUsd > 0n ? (debtUsd * BPS) / collUsd : BPS,
    avgLtvBps,
    avgLiquidationThresholdBps,
  };
}

export interface AccountStats {
  /** Null when there is no debt — nothing to be liquidated against. */
  healthFactorBps: bigint | null;
  /** Collateral over equity. Null when equity is zero or negative. */
  leverageBps: bigint | null;
  /** Debt as a share of total borrow power. Null when there is no borrow power. */
  borrowPowerUsedBps: bigint | null;
  /** Borrow power still unused, 8dp USD. Floors at zero rather than going negative. */
  leftToBorrowUsd: bigint;
}

/**
 * The headline figures for an account, from its USD totals and weighted parameters.
 *
 * Called twice per render — once on what the user holds now, once on what {@link projectOpen}
 * says they would hold after — so every row can be shown as `current → after`. One function for
 * both sides is what stops the two columns being computed differently and quietly disagreeing.
 */
export function accountStats(p: {
  collateralUsd: bigint;
  debtUsd: bigint;
  ltvBps: bigint;
  liquidationThresholdBps: bigint;
}): AccountStats {
  const equityUsd = p.collateralUsd - p.debtUsd;
  const borrowPowerUsd = (p.collateralUsd * p.ltvBps) / BPS;
  const leftToBorrowUsd = borrowPowerUsd - p.debtUsd;

  return {
    healthFactorBps:
      p.debtUsd > 0n ? (p.collateralUsd * p.liquidationThresholdBps) / p.debtUsd : null,
    leverageBps: equityUsd > 0n ? (p.collateralUsd * BPS) / equityUsd : null,
    borrowPowerUsedBps: borrowPowerUsd > 0n ? (p.debtUsd * BPS) / borrowPowerUsd : null,
    leftToBorrowUsd: leftToBorrowUsd > 0n ? leftToBorrowUsd : 0n,
  };
}

/**
 * Every way this panel can refuse, in the order they are checked.
 *
 * The first six are decided before any network call. `ZERO_BORROW` and `LTV_EXCEEDED` are
 * post-quote backstops. The rest come from the router or the contract.
 *
 * There is deliberately no "the swap cannot repay the flash" member: the borrow is derived FROM
 * the repayment obligation, so `AaveV3Strategies.sol:502` is unreachable by construction.
 */
export type LeverageError =
  | "NO_MARGIN"
  | "MARGIN_EXCEEDS_BALANCE"
  | "NO_SUPPLY"
  | "SUPPLY_BELOW_MARGIN"
  /** The debt-path twin of `SUPPLY_BELOW_MARGIN` — see {@link debtMarginFits}. */
  | "MARGIN_EXCEEDS_SUPPLY"
  | "SUPPLY_ABOVE_MAX"
  | "BOOST_NO_HEADROOM"
  | "COLLATERAL_NOT_ENABLED"
  | "ZERO_BORROW"
  | "LTV_EXCEEDED"
  | "NO_ROUTE"
  /**
   * An aggregator refused to answer — throttled or down — rather than answering with no route.
   * Distinct because waiting fixes this one and nothing else.
   */
  | "AGGREGATOR_UNAVAILABLE"
  | "QUOTE_FAILED"
  | "QUOTE_MOVED"
  | "PAUSED"
  | "NO_CLIENT";

/**
 * Why Aave would not count a supply into this reserve toward the user's borrow power.
 *
 * Supplying is not the same as collateralising. `SupplyLogic.executeSupply` only attempts to
 * switch a reserve on as collateral for a FIRST supply that passes
 * `validateAutomaticUseAsCollateral`, and that check refuses any reserve carrying a debt ceiling
 * unless the supplier holds `ISOLATED_COLLATERAL_SUPPLIER_ROLE` — which AaveV3Strategies does not
 * hold and cannot grant itself.
 *
 * When the supply lands as non-collateral, `AaveV3Strategies.sol:487` still borrows successfully —
 * Aave validates the new debt against whatever OTHER collateral the account already has. The
 * position opens, nothing reverts, and the debt is secured by assets the user never chose to
 * pledge. There is no on-chain signal, which is why this has to be caught before quoting.
 */
type CollateralNotCountedReason =
  | "EMODE_EXCLUDED"
  | "NOT_ENABLED"
  | "RESERVE_DISABLED"
  | "ZERO_LTV"
  | "ISOLATION_MODE";

interface CollateralEnablementInput {
  /** The user's current aToken balance. Non-zero means this is not a first supply, so Aave
   *  never runs the auto-enable path at all. */
  scaledATokenBalance: bigint;
  /** Whether the user already has this reserve switched on as collateral. */
  enabledOnUser: boolean;
  /** Reserve-level collateral flag, from `getReservesData`. */
  usageAsCollateralEnabled: boolean;
  /** Reserve LTV in bps. Zero marks a borrow-only or deprecated reserve. */
  ltvBps: bigint;
  /** Non-zero puts the reserve in isolation mode. */
  debtCeiling: bigint;
  /**
   * True when the user sits in an eMode category that does not list this reserve as collateral.
   *
   * Checked separately because it OVERRIDES the collateral flag rather than replacing it:
   * `calculateUserAccountData` assigns such a reserve `ltv = liquidationThreshold = 0` and then
   * skips it (`if (liquidationThreshold != 0 && isUsingAsCollateral(i))`), so the flag can be set
   * and the contribution still zero.
   */
  eModeExcluded: boolean;
  /**
   * Whether the account has any OTHER collateral enabled.
   *
   * This decides the FAILURE MODE, not whether it fails. With none, Aave reverts
   * `COLLATERAL_BALANCE_IS_ZERO` and the user simply cannot open — annoying, harmless. With some,
   * the borrow succeeds against it and the mis-securing is silent, which is the case worth
   * shouting about.
   */
  hasOtherCollateral: boolean;
}

export interface CollateralEnablement {
  willCount: boolean;
  reason: CollateralNotCountedReason | null;
  /** The dangerous case: the open would succeed and pledge unrelated collateral. */
  silentlyMisSecures: boolean;
}

/** See {@link CollateralNotCountedReason}. Mirrors Aave's `validateAutomaticUseAsCollateral`. */
export function collateralEnablement(p: CollateralEnablementInput): CollateralEnablement {
  const no = (reason: CollateralNotCountedReason): CollateralEnablement => ({
    willCount: false,
    reason,
    silentlyMisSecures: p.hasOtherCollateral,
  });

  // First, because it beats every other answer: an out-of-category reserve contributes nothing
  // even when the user has explicitly switched it on.
  if (p.eModeExcluded) return no("EMODE_EXCLUDED");

  // Already on — the supply lands on a reserve that already counts, whatever its config says.
  if (p.enabledOnUser) return { willCount: true, reason: null, silentlyMisSecures: false };

  // Off, so the supply has to switch it on. Aave only tries that on a first supply.
  if (p.scaledATokenBalance !== 0n) return no("NOT_ENABLED");

  // `validateAutomaticUseAsCollateral` → `validateUseAsCollateral`.
  if (!p.usageAsCollateralEnabled) return no("RESERVE_DISABLED");
  if (p.ltvBps === 0n) return no("ZERO_LTV");
  // Refused for ANY debt-ceiling reserve here, not just when the user holds other collateral:
  // the supplier is this contract, which does not hold ISOLATED_COLLATERAL_SUPPLIER_ROLE.
  if (p.debtCeiling !== 0n) return no("ISOLATION_MODE");

  return { willCount: true, reason: null, silentlyMisSecures: false };
}

interface ValidateSizingInput extends DeriveOpenInput {
  marginBalance: bigint;
  /** From {@link maxSupplyAmount}, at whichever ceiling is currently in force. */
  maxSupply: bigint;
  /**
   * From {@link collateralEnablement}. Null skips the check — for callers that have not resolved
   * the reserve config yet, so a missing read degrades to today's behaviour rather than blocking
   * every open.
   */
  collateral?: CollateralEnablement | null;
  /**
   * Oracle prices and the slippage numerator, so a DEBT-asset margin can be measured against the
   * supply it has to fit inside. Null skips that check, on the same grounds as `collateral`.
   */
  pricing?: SeedBorrowPricing | null;
}

/**
 * Whether a debt-asset margin leaves anything to borrow.
 *
 * On the debt path the margin is swap INPUT (AaveV3Strategies.sol:491), and the swap only has to
 * produce the supply. Bring more margin than the supply is worth and the borrow comes out
 * negative — no combination of routes can price that, so it is a sizing error, not a quoting one.
 *
 * Delegated to {@link seedBorrow} rather than re-derived, so the form and the solve cannot
 * disagree about where the boundary sits.
 */
function debtMarginFits(p: ValidateSizingInput): boolean {
  if (p.marginAsset !== "debt" || !p.pricing) return true;
  const { flashAmount, debtMargin } = deriveOpen(p);
  return seedBorrow({ ...p.pricing, flashAmount, debtMargin }) !== null;
}

/**
 * The checks that need no network. Ordered — the first failure is the only one worth showing,
 * because fixing it is what reveals the next.
 */
export function validateSizing(p: ValidateSizingInput): LeverageError | null {
  const boost = p.marginAsset === "none";
  // Boost posts nothing by design; its ceiling comes from the account's own borrow power, so a
  // zero max is the thing to complain about rather than the absent margin.
  if (boost) {
    if (p.maxSupply <= 0n) return "BOOST_NO_HEADROOM";
  } else {
    if (p.marginAmount <= 0n) return "NO_MARGIN";
    if (p.marginAmount > p.marginBalance) return "MARGIN_EXCEEDS_BALANCE";
  }
  if (p.supplyAmount <= 0n) return "NO_SUPPLY";
  // A non-positive flash means the user asked to supply no more than they are posting
  // themselves — nothing to lever, and the contract's ZeroAmount guard rejects it anyway
  // (AaveV3Strategies.sol:274, :331).
  if (deriveOpen(p).flashAmount <= 0n) return "SUPPLY_BELOW_MARGIN";
  if (p.supplyAmount > p.maxSupply) return "SUPPLY_ABOVE_MAX";
  // AFTER the ceiling, deliberately. Both can be true at once, and this one's advice is "supply
  // more" — which would be a contradiction to show while the supply is already over the max.
  if (!debtMarginFits(p)) return "MARGIN_EXCEEDS_SUPPLY";
  // Last, because it is the only one the user cannot fix by retyping a number — showing it while
  // the amounts are still incomplete would be noise.
  if (p.collateral && !p.collateral.willCount) return "COLLATERAL_NOT_ENABLED";
  return null;
}

interface LeverageErrorContext {
  collateralSymbol: string;
  marginSymbol: string;
  /** Pre-formatted for display — this module is bigint-only and knows nothing of decimals. */
  marginBalance: string;
  maxSupply: string;
  /** The ceiling the danger toggle would unlock, or null when it is already unlocked. */
  dangerMaxSupply: string | null;
  /**
   * The margin's worth in COLLATERAL units, pre-formatted — the floor the supply has to clear on
   * the debt path. Null when the caller cannot price it, which costs only the number.
   */
  marginWorth?: string | null;
  /** From {@link collateralEnablement}, so `COLLATERAL_NOT_ENABLED` can say WHICH way it failed. */
  collateral?: CollateralEnablement | null;
}

/**
 * Why this reserve will not back the borrow, in the user's terms.
 *
 * Split out because the five reasons need genuinely different advice — two are fixable by the
 * user in one transaction, two are not fixable at all, and one is only fixable by unwinding the
 * rest of their account.
 */
function collateralNotCountedMessage(ctx: LeverageErrorContext): string {
  const symbol = ctx.collateralSymbol;
  switch (ctx.collateral?.reason) {
    case "EMODE_EXCLUDED":
      return `Your E-Mode category doesn't include ${symbol}, so supplying it adds no borrowing power — switch E-Mode off, or pick a collateral inside your category`;
    case "NOT_ENABLED":
      return `You already hold ${symbol} with "use as collateral" switched off — turn it on in Aave first, or this supply won't back the borrow`;
    case "RESERVE_DISABLED":
      return `Aave doesn't accept ${symbol} as collateral`;
    case "ZERO_LTV":
      return `${symbol} has no borrowing power on Aave — it can be supplied but not borrowed against`;
    case "ISOLATION_MODE":
      return `${symbol} is an isolated asset, and Aave won't enable it as collateral when it's supplied on your behalf`;
    default:
      return `Aave won't count ${symbol} as collateral for your account`;
  }
}

/** User-facing copy. The enum members are internal names meant for logs, never for a UI. */
export function leverageErrorMessage(error: LeverageError, ctx: LeverageErrorContext): string {
  switch (error) {
    case "NO_MARGIN":
      return `Enter how much ${ctx.marginSymbol} you want to put in`;
    case "MARGIN_EXCEEDS_BALANCE":
      return `You have ${ctx.marginBalance} ${ctx.marginSymbol}`;
    case "NO_SUPPLY":
      return `Enter how much ${ctx.collateralSymbol} to supply`;
    case "SUPPLY_BELOW_MARGIN":
      return `Supply more ${ctx.collateralSymbol} than you post yourself — the difference is what gets levered`;
    case "MARGIN_EXCEEDS_SUPPLY":
      // Never "try a smaller supply", which is what the old QUOTE_FAILED said here and is the
      // opposite of the fix: the supply is the thing the margin has to fit inside.
      return ctx.marginWorth !== null && ctx.marginWorth !== undefined
        ? `Your margin is worth about ${ctx.marginWorth} ${ctx.collateralSymbol} — supply more than that, or post less ${ctx.marginSymbol}`
        : `Your ${ctx.marginSymbol} margin is worth more than the ${ctx.collateralSymbol} you're supplying — supply more, or post less margin`;
    case "SUPPLY_ABOVE_MAX":
      return ctx.dangerMaxSupply !== null
        ? `Max supply is ${ctx.maxSupply} ${ctx.collateralSymbol} — turn on the danger zone for ${ctx.dangerMaxSupply}`
        : `Max supply is ${ctx.maxSupply} ${ctx.collateralSymbol}`;
    case "BOOST_NO_HEADROOM":
      return "No borrow power left to boost with — repay some debt or supply more collateral";
    case "COLLATERAL_NOT_ENABLED": {
      const why = collateralNotCountedMessage(ctx);
      // Spelling out the consequence only where it exists. With no other collateral Aave simply
      // rejects the borrow, so warning about pledged assets would be a lie.
      return ctx.collateral?.silentlyMisSecures
        ? `${why}. Your existing collateral would be backing this debt instead.`
        : why;
    }
    case "ZERO_BORROW":
      return "This position is too small to route";
    case "LTV_EXCEEDED":
      return `Too much debt against this much ${ctx.collateralSymbol} — Aave would reject the borrow`;
    case "NO_ROUTE":
      return "No allowlisted router can price this pair";
    case "AGGREGATOR_UNAVAILABLE":
      return "The price aggregator is rate-limiting us or is down — wait a moment and refresh";
    case "QUOTE_FAILED":
      return "Could not price this position — try a smaller supply";
    case "QUOTE_MOVED":
      return "The rate moved while pricing this — refresh to requote";
    case "PAUSED":
      return "Leverage is paused";
    case "NO_CLIENT":
      return "Wallet client unavailable";
  }
}
