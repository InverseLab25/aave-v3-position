import type { Adapter } from './types';
import { kyberSwapAdapter } from './kyberswap';
import { openOceanAdapter } from './openocean';
import { paraSwapAdapter } from './paraswap';
import { cowSwapAdapter } from './cowswap';
import { odosAdapter } from './odos';
import { zeroxAdapter } from './zerox';

export const allAdapters: Adapter[] = [
  kyberSwapAdapter,
  openOceanAdapter,
  paraSwapAdapter,
  cowSwapAdapter,
  odosAdapter,
  zeroxAdapter
];

/** Returns only the adapters available on the given chain */
export function getAdaptersForChain(allowedNames: string[]): Adapter[] {
  if (allowedNames.length === 0) return [];
  return allAdapters.filter(a => allowedNames.includes(a.name));
}

export * from './types';
