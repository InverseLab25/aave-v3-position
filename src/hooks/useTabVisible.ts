import { useSyncExternalStore } from 'react'

const subscribe = (onChange: () => void) => {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

const isVisible = () => document.visibilityState === 'visible'

/**
 * Whether the browser window showing this page is in front.
 *
 * Quoting is the app's most expensive background habit: a close quote takes several seconds at
 * size and both flows repeat on a three-second cadence, so a forgotten tab spends an
 * aggregator's rate limit on prices nobody is reading. This is one half of the answer — the
 * other is the in-app tab, which the components take as an `active` prop, because a panel hidden
 * behind `display: none` is just as unwatched and `visibilitychange` says nothing about it.
 *
 * `useSyncExternalStore` rather than an effect and a piece of state: the value is read during
 * render to decide whether to quote at all, and an effect would let one run go out first.
 */
export function useTabVisible(): boolean {
  return useSyncExternalStore(subscribe, isVisible, () => true)
}
