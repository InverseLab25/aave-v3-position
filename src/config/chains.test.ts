import { afterEach, expect, it } from 'vitest';
import { CHAIN_CONFIGS, getStrategiesAddress } from './chains';

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
