import { describe, it, expect } from 'vitest'
import type { Connector } from 'wagmi'
import { usableConnectors } from './walletConnectors'

const connector = (id: string, name: string) => ({ id, name, uid: id }) as unknown as Connector

describe('usableConnectors', () => {
  it('leaves out the one already connected', () => {
    // Offering it again does not reconnect — it throws ConnectorAlreadyConnectedError, which the
    // user sees as the modal refusing to close for no stated reason.
    const active = connector('io.metamask', 'MetaMask')
    const list = [active, connector('io.rabby', 'Rabby')]

    expect(usableConnectors(list, active).map((c) => c.name)).toEqual(['Rabby'])
  })

  it('shows the same wallet once, however many times it announces itself', () => {
    // EIP-6963 discovery is on by default, so an installed wallet reports under its own name.
    // Anything configured explicitly for that wallet arrives as a second entry for one provider.
    const list = [
      connector('io.metamask', 'MetaMask'),
      connector('injected', 'MetaMask'),
      connector('io.rabby', 'Rabby'),
    ]

    expect(usableConnectors(list, undefined).map((c) => c.id)).toEqual(['io.metamask', 'io.rabby'])
  })

  it('matches those names regardless of case or padding', () => {
    const list = [connector('a', 'MetaMask'), connector('b', ' metamask ')]

    expect(usableConnectors(list, undefined)).toHaveLength(1)
  })

  it('keeps the first of a duplicate pair, which is the discovered one', () => {
    // Discovery runs first, so the surviving entry is the one carrying the wallet's real icon
    // and name rather than a configured stand-in.
    const list = [connector('io.metamask', 'MetaMask'), connector('injected', 'MetaMask')]

    expect(usableConnectors(list, undefined)[0].id).toBe('io.metamask')
  })

  it('answers empty when nothing is installed, rather than throwing', () => {
    // Which is what the picker renders its "no wallet detected" message from.
    expect(usableConnectors([], undefined)).toEqual([])
  })
})
