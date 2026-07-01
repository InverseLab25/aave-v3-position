import type { Adapter } from './types';
import { kyberSwapAdapter } from './kyberswap';
import { openOceanAdapter } from './openocean';
import { paraSwapAdapter } from './paraswap';
import { cowSwapAdapter } from './cowswap';

export const allAdapters: Adapter[] = [
  kyberSwapAdapter,
  openOceanAdapter,
  paraSwapAdapter,
  cowSwapAdapter
];

/** Returns only the adapters available on the given chain */
export function getAdaptersForChain(allowedNames: string[]): Adapter[] {
  if (allowedNames.length === 0) return [];
  return allAdapters.filter(a => allowedNames.includes(a.name));
}

export * from './types';
