import { useCallback, useRef, useState } from 'react'
import { useChainId, useConnection, usePublicClient, useWalletClient } from 'wagmi'
import { parseAbi, type Address, type Hex } from 'viem'
import { getChainConfig, getFlipperAddress } from '../config/chains'
import { adjustedFees, pinnedGasLimit } from '../utils/gas'
import { getATokenName, getPoolDataProvider, getReserveTokens } from '../lib/aaveStatics'
import { getAdaptersForChain } from '../adapters'
import type { Asset, QuoteResponse } from '../adapters/types'
import { canReuseSignature, reuseBlocker, selectRoute, type HeldSignature } from '../lib/closePlan'
import { collateralEnablement } from '../lib/leverage'
import {
  aaveV3FlipperAbi,
  buildATokenPermit,
  buildCreditDelegation,
  buildRevokePermit,
  planFlip,
  sizeFlip,
  toStrategiesSig,
  WAD,
  type FlipSize,
} from '../lib/strategies-sdk'

/*//////////////////////////////////////////////////////////////
                           CONSTANTS
//////////////////////////////////////////////////////////////*/

/**
 * How far the flash is sized against a rate worse than quoted.
 *
 * Unlike the open flow this is not protecting a flash repayment — the flip repays in kind out of
 * the withdrawal plus the borrow, both fixed before the swap runs. What the buffer buys is that
 * the requested leverage becomes a CEILING rather than a target: size against a rate slightly
 * worse than quoted, fill at the quoted one, and the surplus lands as extra collateral and pulls
 * realized leverage below what was asked for. Undershooting is the safe side.
 */
const RATE_BUFFER_BPS = 50n

/**
 * Quote rounds allowed while converging on the flash size.
 *
 * Two, where `solveBorrow` takes more. There the loop is a SAFETY loop: under-sizing means the
 * swap cannot repay the flash and the whole transaction reverts, so it has to converge. Here a
 * mis-sized flash only lands leverage a fraction of a percent off, so the second round is for
 * accuracy and a third is not worth another round trip to every aggregator.
 */
const QUOTE_ROUNDS = 2

/** How long a signature stays valid. Long enough to survive a build and inclusion. */
const SIGNATURE_TTL_S = 1800n

/**
 * Headroom the aToken permit grants above the pull (25%).
 *
 * It can never mean a larger withdrawal: the contract pulls the balance it reads for itself, and
 * the grant is revoked inside the same transaction. What it buys is survival — sized exactly, a
 * signature is invalidated by the first aToken rebase that drifts a single wei upward.
 */
const PERMIT_HEADROOM_BPS = 2500n

export const RECEIPT_TIMEOUT_MS = 90_000

const POOL_ADDRESSES_PROVIDER_ABI = parseAbi(['function getPriceOracle() view returns (address)'])
const ORACLE_ABI = parseAbi(['function getAssetPrice(address asset) view returns (uint256)'])
const DATA_PROVIDER_ABI = parseAbi([
  'function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
  'function getDebtCeiling(address asset) view returns (uint256)',
  'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
])
const NONCES_ABI = parseAbi(['function nonces(address owner) view returns (uint256)'])

/*//////////////////////////////////////////////////////////////
                             TYPES
//////////////////////////////////////////////////////////////*/

export class FlipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FlipError'
  }
}

export interface FlipInput {
  /** Held as collateral now, owed as debt after. The asset that gets flashed and sold. */
  fromAsset: Asset
  /** Owed now, held as collateral after. */
  toAsset: Asset
  /** Target leverage on the flipped position, bps. 20000n == 2.00x. */
  leverageBps: bigint
  slippagePercent: number
}

export interface FlipPreview extends FlipSize {
  /** The whole aToken balance being given up. */
  collateralAmount: bigint
  /** The whole variable debt being retired. */
  debtAmount: bigint
  router: Address
  swapData: Hex
  /** The chosen route's quoted output, before the user's slippage is applied. */
  quotedOut: bigint
}

export type FlipStep = 'idle' | 'permit' | 'revoke' | 'delegation' | 'sending' | 'done' | 'error'

/** Everything a flip has to read off chain, gathered once per attempt. */
interface Position {
  aFrom: Address
  aFromName: string
  vDebtFrom: Address
  vDebtFromName: string
  collateralAmount: bigint
  debtAmount: bigint
  fromPriceUsd: bigint
  toPriceUsd: bigint
  fromDecimals: number
  toDecimals: number
  ltvBps: bigint
  liquidationThresholdBps: bigint
  aTokenNonce: bigint
  delegationNonce: bigint
}

/*//////////////////////////////////////////////////////////////
                              HOOK
//////////////////////////////////////////////////////////////*/

export function useFlipPosition() {
  const { address } = useConnection()
  const chainId = useChainId()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()

  const [logs, setLogs] = useState<string[]>([])
  const [step, setStep] = useState<FlipStep>('idle')
  const [execError, setExecError] = useState<string | null>(null)
  const log = useCallback((m: string) => setLogs((prev) => [...prev, m]), [])

  /**
   * The aToken permit pair, signed but not yet spent. An EIP-2612 signature is single-use only
   * ON CONSUMPTION, so one that was never broadcast stays valid until its deadline and a second
   * press reuses it rather than re-prompting. The delegation is deliberately NOT held: it commits
   * to an exact borrow amount that changes with every re-quote.
   */
  const signatures = useRef<HeldSignature | null>(null)
  const clearSignatures = useCallback(() => {
    signatures.current = null
  }, [])

  /*────────────────────────── reads ──────────────────────────*/

  const readPosition = useCallback(
    async (input: FlipInput): Promise<Position> => {
      if (!publicClient) throw new FlipError('No RPC client for this chain')
      if (!address) throw new FlipError('Connect a wallet first')

      const cfg = getChainConfig(chainId)
      if (!cfg) throw new FlipError('Unsupported chain')

      const fromAddr = input.fromAsset.underlyingAsset as Address
      const toAddr = input.toAsset.underlyingAsset as Address

      const dataProvider = await getPoolDataProvider(
        publicClient,
        chainId,
        cfg.aave.poolAddressesProvider,
      )
      const oracle = (await publicClient.readContract({
        address: cfg.aave.poolAddressesProvider,
        abi: POOL_ADDRESSES_PROVIDER_ABI,
        functionName: 'getPriceOracle',
      })) as Address

      const from = await getReserveTokens(publicClient, chainId, dataProvider, fromAddr)

      const price = (asset: Address) =>
        publicClient.readContract({
          address: oracle,
          abi: ORACLE_ABI,
          functionName: 'getAssetPrice',
          args: [asset],
        }) as Promise<bigint>

      const reserveConfig = (asset: Address) =>
        publicClient.readContract({
          address: dataProvider,
          abi: DATA_PROVIDER_ABI,
          functionName: 'getReserveConfigurationData',
          args: [asset],
        }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean, boolean, boolean]>

      const userReserve = (asset: Address) =>
        publicClient.readContract({
          address: dataProvider,
          abi: DATA_PROVIDER_ABI,
          functionName: 'getUserReserveData',
          args: [asset, address],
        }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, number, boolean]>

      const nonces = (token: Address) =>
        publicClient.readContract({
          address: token,
          abi: NONCES_ABI,
          functionName: 'nonces',
          args: [address],
        }) as Promise<bigint>

      const [
        fromPriceUsd,
        toPriceUsd,
        fromConfig,
        toConfig,
        fromUser,
        toUser,
        debtCeiling,
        aTokenNonce,
        delegationNonce,
        aFromName,
      ] = await Promise.all([
        price(fromAddr),
        price(toAddr),
        reserveConfig(fromAddr),
        reserveConfig(toAddr),
        userReserve(fromAddr),
        userReserve(toAddr),
        publicClient.readContract({
          address: dataProvider,
          abi: DATA_PROVIDER_ABI,
          functionName: 'getDebtCeiling',
          args: [toAddr],
        }) as Promise<bigint>,
        nonces(from.aToken),
        nonces(from.vDebt),
        getATokenName(publicClient, chainId, from.aToken),
      ])

      // Supplying is not collateralising. Aave only auto-enables a reserve on a FIRST supply, and
      // the contract cannot switch it on for the user because Aave scopes that to msg.sender.
      // Caught here because on chain it surfaces as a borrow revert AFTER the swap has happened.
      const enablement = collateralEnablement({
        scaledATokenBalance: toUser[0],
        enabledOnUser: toUser[8],
        usageAsCollateralEnabled: toConfig[5],
        ltvBps: toConfig[1],
        debtCeiling,
        eModeExcluded: false,
        hasOtherCollateral: fromUser[0] > 0n,
      })
      if (!enablement.willCount) {
        throw new FlipError(
          `Aave will not count the new ${input.toAsset.symbol} supply as collateral (${enablement.reason}), so the borrow would fail. Enable it as collateral first.`,
        )
      }

      return {
        aFrom: from.aToken,
        aFromName,
        vDebtFrom: from.vDebt,
        // Aave names a variable-debt token after its aToken's reserve, and the EIP-712 domain
        // uses that name. Read separately rather than assumed equal to the aToken's.
        vDebtFromName: await getATokenName(publicClient, chainId, from.vDebt),
        collateralAmount: fromUser[0],
        debtAmount: toUser[2],
        fromPriceUsd,
        toPriceUsd,
        fromDecimals: Number(fromConfig[0]),
        toDecimals: Number(toConfig[0]),
        // The wall is the DESTINATION reserve's, never the one being left behind.
        ltvBps: toConfig[1],
        liquidationThresholdBps: toConfig[2],
        aTokenNonce,
        delegationNonce,
      }
    },
    [address, chainId, publicClient],
  )

  /*────────────────────────── sizing ──────────────────────────*/

  const preview = useCallback(
    async (input: FlipInput): Promise<FlipPreview> => {
      const fromAddr = input.fromAsset.underlyingAsset as Address
      const toAddr = input.toAsset.underlyingAsset as Address
      if (fromAddr.toLowerCase() === toAddr.toLowerCase()) {
        throw new FlipError('Same asset on both sides — that is not a flip')
      }

      const flipper = getFlipperAddress(chainId)
      if (!flipper) throw new FlipError('Position flips are not deployed on this chain')

      const cfg = getChainConfig(chainId)
      if (!cfg) throw new FlipError('Unsupported chain')

      const pos = await readPosition(input)
      if (pos.collateralAmount === 0n) throw new FlipError('No collateral to flip')

      const slipNum = BigInt(Math.round((100 - input.slippagePercent) * 100))
      const adapters = getAdaptersForChain(cfg.adapters ?? [])

      // Which routers the contract will accept. A quote through anything else is wasted work,
      // and the rejection is only visible after `buildTransaction` names the router.
      const allowedRouters = new Set(
        (
          (await publicClient!.readContract({
            address: flipper,
            abi: aaveV3FlipperAbi,
            functionName: 'getAllowedRouters',
          })) as readonly Address[]
        ).map((r) => r.toLowerCase()),
      )

      const fromUnit = 10n ** BigInt(pos.fromDecimals)
      const toUnit = 10n ** BigInt(pos.toDecimals)

      // Round one seeds off the oracle: no network call, and it only has to be close enough to
      // ask the aggregator a sensible question.
      let rateWad = (pos.fromPriceUsd * toUnit * WAD) / (pos.toPriceUsd * fromUnit)
      let size = unwrapSize(sizeFlip({ ...sizingInput(input, pos), rateWad }))
      let route: Awaited<ReturnType<typeof selectRoute>> | null = null

      for (let round = 0; round < QUOTE_ROUNDS; round++) {
        const candidates = await quoteAll(adapters, input, size.flashAmount, chainId)
        route = await selectRoute({
          candidates,
          adapters,
          strategies: flipper,
          allowedRouters,
          slippagePercent: input.slippagePercent,
          chainId,
          // The sale has to clear the debt it is retiring, or the leg reverts before it can
          // supply anything. Below that bar a route is not usable at any leverage.
          debt: pos.debtAmount,
          slipNum,
        })
        if (!route?.chosen) {
          throw new FlipError(
            `No route for this flip${route?.rejected.length ? `: ${route.rejected.join('; ')}` : ''}`,
          )
        }
        // Re-derive the rate from what the aggregator actually offered for THIS input, then
        // resize. Round two lands on a size a router has really quoted.
        rateWad = (BigInt(route.chosen.amountOut) * WAD) / size.flashAmount
        size = unwrapSize(sizeFlip({ ...sizingInput(input, pos), rateWad }))
      }

      if (!route?.router || !route.swapData || !route.chosen) {
        throw new FlipError('No route for this flip')
      }

      log(`flip sized: flash ${size.flashAmount}, borrow ${size.borrowAmount}`)

      return {
        ...size,
        collateralAmount: pos.collateralAmount,
        debtAmount: pos.debtAmount,
        router: route.router,
        swapData: route.swapData,
        quotedOut: BigInt(route.chosen.amountOut),
      }
    },
    [chainId, log, publicClient, readPosition],
  )

  /*────────────────────────── execution ──────────────────────────*/

  const flip = useCallback(
    async (input: FlipInput) => {
      setExecError(null)
      try {
        if (!walletClient) throw new FlipError('Connect a wallet first')
        if (!publicClient) throw new FlipError('No RPC client for this chain')
        if (!address) throw new FlipError('Connect a wallet first')

        const flipper = getFlipperAddress(chainId)
        if (!flipper) throw new FlipError('Position flips are not deployed on this chain')

        const plan = await preview(input)
        const pos = await readPosition(input)
        const now = BigInt(Math.floor(Date.now() / 1000))
        const deadline = now + SIGNATURE_TTL_S

        const permitValue =
          plan.collateralAmount + (plan.collateralAmount * PERMIT_HEADROOM_BPS) / 10000n

        // The pull, not the headroomed grant. Comparing against the grant inflates both sides by
        // the same factor and leaves no drift tolerance at all, which is the point of the headroom.
        const need = {
          chainId,
          owner: address,
          aToken: pos.aFrom,
          spender: flipper,
          nonce: pos.aTokenNonce,
          value: plan.collateralAmount,
          nowSeconds: now,
        }

        let held = signatures.current
        if (!canReuseSignature(held, need)) {
          if (held) log(`re-signing: ${reuseBlocker(held, need)}`)

          setStep('permit')
          const permitSig = await walletClient.signTypedData(
            buildATokenPermit({
              chainId,
              token: pos.aFrom,
              tokenName: pos.aFromName,
              owner: address,
              spender: flipper,
              value: permitValue,
              nonce: pos.aTokenNonce,
              deadline,
            }),
          )

          setStep('revoke')
          const revokeSig = await walletClient.signTypedData(
            // Default nonceOffset of 1: the grant above consumes nonce N inside the transaction,
            // so the revoke has to sit at N+1. Wrong offset reverts with InvalidExpiration().
            buildRevokePermit({
              chainId,
              token: pos.aFrom,
              tokenName: pos.aFromName,
              owner: address,
              spender: flipper,
              nonce: pos.aTokenNonce,
              deadline,
            }),
          )

          held = {
            ...need,
            value: permitValue,
            deadline,
            permit: {
              value: permitValue,
              deadline,
              ...splitSig(toStrategiesSig(permitSig, deadline)),
            },
            revoke: { deadline, ...splitSig(toStrategiesSig(revokeSig, deadline)) },
            reviewedOut: plan.quotedOut,
          }
          signatures.current = held
        }
        if (!held) throw new FlipError('Lost the permit pair between signing and sending')

        // Built AFTER sizing and never held: the contract borrows the full signed value, so a
        // figure from an earlier round either reverts or leaves borrowing power granted away.
        setStep('delegation')
        const delegationSig = await walletClient.signTypedData(
          buildCreditDelegation({
            chainId,
            debtToken: pos.vDebtFrom,
            debtTokenName: pos.vDebtFromName,
            delegatee: flipper,
            value: plan.borrowAmount,
            nonce: pos.delegationNonce,
            deadline,
          }),
        )

        const { functionName, args } = planFlip({
          fromAsset: input.fromAsset.underlyingAsset as Address,
          toAsset: input.toAsset.underlyingAsset as Address,
          flashAmount: plan.flashAmount,
          borrowAmount: plan.borrowAmount,
          minOut: plan.minOut,
          router: plan.router,
          permit: {
            amount: held.permit.value,
            deadline: held.permit.deadline,
            r: held.permit.r,
            s: held.permit.s,
            v: held.permit.v,
          },
          revokePermit: held.revoke,
          delegation: toStrategiesSig(delegationSig, deadline),
          swapData: plan.swapData,
        })

        // Estimated here, never left to the wallet. A flip touches a flash loan, a swap, a
        // repay, a supply, a withdraw and a borrow in one transaction, and an unbuffered guess
        // made against pre-swap state runs out of gas partway through. A failed estimate throws
        // before the write, and `signatures.current` is only cleared on a receipt — so the
        // permit pair survives and a retry costs no new wallet prompt.
        const gas = await pinnedGasLimit(
          () =>
            publicClient.estimateContractGas({
              address: flipper,
              abi: aaveV3FlipperAbi,
              functionName,
              args,
              account: address,
            }),
          { chainId, label: 'flip' },
        )

        const fees = await adjustedFees(publicClient)

        setStep('sending')
        const hash = await walletClient.writeContract({
          address: flipper,
          abi: aaveV3FlipperAbi,
          functionName,
          args,
          gas,
          ...fees,
        })

        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          timeout: RECEIPT_TIMEOUT_MS,
        })
        // Spent on inclusion, so it can never be reused whatever the receipt says.
        signatures.current = null
        setStep(receipt.status === 'success' ? 'done' : 'error')
        return { hash, receipt }
      } catch (e) {
        setStep('error')
        setExecError(e instanceof Error ? e.message : String(e))
        throw e
      }
    },
    [address, chainId, log, preview, publicClient, readPosition, walletClient],
  )

  return { preview, flip, step, logs, execError, clearSignatures }
}

/*//////////////////////////////////////////////////////////////
                            HELPERS
//////////////////////////////////////////////////////////////*/

function sizingInput(input: FlipInput, pos: Position) {
  return {
    collateralAmount: pos.collateralAmount,
    debtAmount: pos.debtAmount,
    leverageBps: input.leverageBps,
    fromPriceUsd: pos.fromPriceUsd,
    toPriceUsd: pos.toPriceUsd,
    fromDecimals: pos.fromDecimals,
    toDecimals: pos.toDecimals,
    ltvBps: pos.ltvBps,
    liquidationThresholdBps: pos.liquidationThresholdBps,
    rateBufferBps: RATE_BUFFER_BPS,
    slippageBps: BigInt(Math.round(input.slippagePercent * 100)),
  }
}

/** Surfaces `sizeFlip`'s error union as a throw, so callers have one failure channel. */
function unwrapSize(r: ReturnType<typeof sizeFlip>): FlipSize {
  if (!r.ok) throw new FlipError(r.error)
  return r.size
}

function splitSig(sig: ReturnType<typeof toStrategiesSig>) {
  return { v: sig.v, r: sig.r, s: sig.s }
}

/**
 * Every adapter that answers, best output first. An aggregator that refused is simply absent —
 * a refusal is not evidence about the pair, and `selectRoute` reports what it rejected and why.
 */
async function quoteAll(
  adapters: ReturnType<typeof getAdaptersForChain>,
  input: FlipInput,
  amountIn: bigint,
  chainId: number,
): Promise<QuoteResponse[]> {
  const settled = await Promise.allSettled(
    adapters.map((a) =>
      a.getQuote(
        input.fromAsset,
        input.toAsset,
        amountIn.toString(),
        input.slippagePercent,
        chainId,
      ),
    ),
  )
  return settled
    .flatMap((s) => (s.status === 'fulfilled' && s.value ? [s.value] : []))
    .sort((a, b) => (BigInt(b.amountOut) > BigInt(a.amountOut) ? 1 : -1))
}
