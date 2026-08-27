import type { Address, PublicClient } from 'viem'
import { getChainConfig } from '../../config/chains'
import { getATokenName, getPoolDataProvider, getReserveTokens } from '../../lib/aaveStatics'
import { collateralEnablement } from '../../lib/leverage'
import {
  DATA_PROVIDER_ABI,
  NONCES_ABI,
  ORACLE_ABI,
  POOL_ADDRESSES_PROVIDER_ABI,
} from '../flip/constants'
import { FlipError, type FlipInput, type Position } from '../flip/types'

/** What the position read needs from the hook. Passed in, so it can be tested without React. */
interface ReadPositionContext {
  address: Address | undefined
  chainId: number
  publicClient: PublicClient | undefined
}

/**
 * Everything a flip has to know before it can size anything: both reserves' prices, configs and
 * balances, the two nonces, and whether Aave will actually count the new supply as collateral.
 *
 * That last check is why this throws rather than returning a partial answer. Supplying is not
 * collateralising, and on chain the difference shows up as a borrow revert AFTER the swap has
 * already happened.
 */
export async function readPosition(
  input: FlipInput,
  ctx: ReadPositionContext,
): Promise<Position> {
  const { address, chainId, publicClient } = ctx

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
}
