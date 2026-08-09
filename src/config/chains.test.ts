import { expect, it } from 'vitest';
import { getStrategiesAddress } from './chains';

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
