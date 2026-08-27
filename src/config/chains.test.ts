import { afterEach, describe, expect, it } from 'vitest';
import {
  CHAIN_CONFIGS,
  getFlipperAddress,
  getStrategiesAddress,
  getStrategiesFromBlock,
  getTxGasCap,
  syncableChains,
} from './chains';

const originalAave = { ...CHAIN_CONFIGS[1].aave };

afterEach(() => {
  // getStrategiesAddress reads CHAIN_CONFIGS at call time, and the object is mutable, so tests
  // below mutate it directly rather than re-importing the module. Restore it so ordering never
  // affects the null-path tests.
  CHAIN_CONFIGS[1].aave = { ...originalAave };
});

it('returns null when the address is unset', () => {
  // The contract is undeployed, so VITE_STRATEGIES_ADDRESS_1 is empty in every environment
  // this suite runs in.
  expect(getStrategiesAddress(1)).toBeNull();
});

it('returns null for an unknown chain', () => {
  expect(getStrategiesAddress(999999)).toBeNull();
});

it('returns null for an undefined chain id', () => {
  expect(getStrategiesAddress(undefined)).toBeNull();
});

// This used to assert it read `strategies` rather than the sibling `deleverager` field. That
// field is gone — AaveV3Strategies carries the close entry point too — so there is only one
// address per chain to get wrong now.
it('reads the strategies field', () => {
  CHAIN_CONFIGS[1].aave.strategies = '0x1111111111111111111111111111111111111111';
  expect(getStrategiesAddress(1)).toBe('0x1111111111111111111111111111111111111111');
});

it('returns null for the zero address', () => {
  CHAIN_CONFIGS[1].aave.strategies = '0x0000000000000000000000000000000000000000';
  expect(getStrategiesAddress(1)).toBeNull();
});

it('returns null for a malformed address', () => {
  CHAIN_CONFIGS[1].aave.strategies = '0xnope' as `0x${string}`;
  expect(getStrategiesAddress(1)).toBeNull();
});

it('has no start block for a chain with no strategies address', () => {
  // A start block on its own is not scannable: there is nothing at that address to look for.
  expect(getStrategiesFromBlock(1)).toBeNull();
  expect(getStrategiesFromBlock(999999)).toBeNull();
  expect(getStrategiesFromBlock(undefined)).toBeNull();
});

it('refuses to scan a chain whose deployment block is unknown', () => {
  // The dangerous case. Falling back to genesis here would walk every block a public RPC has,
  // in chunks, looking for a contract that may never have been deployed on that chain.
  CHAIN_CONFIGS[1].aave.strategies = '0x1111111111111111111111111111111111111111';

  expect(getStrategiesFromBlock(1)).toBeNull();
  expect(syncableChains().map((c) => c.chainId)).not.toContain(1);
});

it('offers only chains that have both an address and a start block', () => {
  for (const chain of syncableChains()) {
    expect(getStrategiesAddress(chain.chainId)).toBe(chain.address);
    expect(chain.fromBlock).toBeGreaterThan(0n);
  }
});

it('returns null when the flipper address is unset', () => {
  // Undeployed everywhere this suite runs, so VITE_FLIPPER_ADDRESS_1 is empty.
  expect(getFlipperAddress(1)).toBeNull();
});

it('reads the flipper field, not the strategies one', () => {
  // Two separate deployments with separate owners and allowlists. Reading across them would
  // send a flip at the Strategies contract, whose ABI has no such entry point.
  CHAIN_CONFIGS[1].aave = {
    ...originalAave,
    strategies: '0x1111111111111111111111111111111111111111',
    flipper: '0x2222222222222222222222222222222222222222',
  };
  expect(getFlipperAddress(1)).toBe('0x2222222222222222222222222222222222222222');
  expect(getStrategiesAddress(1)).toBe('0x1111111111111111111111111111111111111111');
});

it('rejects a zero or malformed flipper address', () => {
  CHAIN_CONFIGS[1].aave = { ...originalAave, flipper: '0x0000000000000000000000000000000000000000' };
  expect(getFlipperAddress(1)).toBeNull();
  CHAIN_CONFIGS[1].aave = { ...originalAave, flipper: '0xnope' as `0x${string}` };
  expect(getFlipperAddress(1)).toBeNull();
});

describe('getTxGasCap', () => {
  it('caps Base and Ethereum at 2^24, the figure their nodes actually enforce', () => {
    // Probed against live RPCs: 16,777,216 clears validation, 16,777,217 comes back
    // "gas limit too high" before the nonce or balance is even looked at.
    expect(getTxGasCap(1)).toBe(16_777_216n);
    expect(getTxGasCap(8453)).toBe(16_777_216n);
  });

  it('leaves Arbitrum uncapped, because it accepts far more in one transaction', () => {
    expect(getTxGasCap(42161)).toBeUndefined();
  });

  it('returns undefined for an unknown chain rather than inventing a ceiling', () => {
    // A guessed cap rejects routes that would have gone through, which is worse than no check.
    expect(getTxGasCap(999999)).toBeUndefined();
    expect(getTxGasCap(undefined)).toBeUndefined();
  });
});
