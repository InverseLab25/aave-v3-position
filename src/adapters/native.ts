/**
 * Native-token (ETH / BNB / POL / AVAX …) handling shared across adapters and UI.
 *
 * The UI represents the chain's native currency with a single canonical sentinel
 * address (the de-facto EIP standard `0xEeee…EEeE`). Most aggregators (Kyber,
 * OpenOcean, ParaSwap) accept this sentinel directly; a few use a different marker
 * (e.g. DefiLlama/Odos uses the zero address), so those adapters translate it.
 */
export const NATIVE_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/** Zero address — native marker used by DefiLlama's swap API (Odos adapter). */
export const NATIVE_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** True when `addr` is the canonical native-token sentinel (case-insensitive). */
export function isNativeAddress(addr?: string): boolean {
  return !!addr && addr.toLowerCase() === NATIVE_ADDRESS.toLowerCase();
}
