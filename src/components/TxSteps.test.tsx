import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TxSteps } from './TxSteps'

describe('TxSteps', () => {
  it('ticks what is behind the user and names what is left', () => {
    render(
      <TxSteps
        steps={[
          { label: 'approved', done: true },
          { label: 'signed', done: true },
          { label: 'send', done: false, active: true },
        ]}
      />,
    )

    expect(screen.getByText(/✓ approved/)).toBeTruthy()
    expect(screen.getByText(/✓ signed/)).toBeTruthy()
    expect(screen.getByText('send')).toBeTruthy()
  })

  it('does not tick a step that has not happened', () => {
    render(<TxSteps steps={[{ label: 'approved', done: false }]} />)

    expect(screen.queryByText(/✓ approved/)).toBeNull()
    expect(screen.getByText('approved')).toBeTruthy()
  })

  it('separates the steps so they read as one sentence', () => {
    const { container } = render(
      <TxSteps steps={[{ label: 'signed', done: true }, { label: 'send', done: false }]} />,
    )

    // A single separator, not one trailing every step.
    expect(container.textContent).toBe('✓ signed · send')
  })

  it('emphasises the step in progress over the ones merely pending', () => {
    // Three states, not two: behind you, happening now, and not yet reached. Collapsing the last
    // two makes a flow that has stalled look identical to one that is working.
    const { container } = render(
      <TxSteps
        steps={[
          { label: 'signed', done: true },
          { label: 'send', done: false, active: true },
        ]}
      />,
    )

    const spans = container.querySelectorAll('span')
    const send = [...spans].find((s) => s.textContent === 'send')
    expect(send?.style.fontWeight).toBe('700')
  })

  it('reports progress to a screen reader as a whole, not as fragments', () => {
    render(<TxSteps steps={[{ label: 'signed', done: true }, { label: 'send', done: false }]} />)

    const region = screen.getByRole('status')
    expect(region.getAttribute('aria-label')).toBe('Progress: signed done, send pending')
  })

  it('renders nothing when a flow has no steps worth showing', () => {
    const { container } = render(<TxSteps steps={[]} />)

    expect(container.firstChild).toBeNull()
  })
})
