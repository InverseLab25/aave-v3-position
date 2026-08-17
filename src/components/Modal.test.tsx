import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Modal } from './Modal'

const show = (over: Partial<Parameters<typeof Modal>[0]> = {}) => {
  const props = {
    title: 'Withdraw WETH',
    onClose: vi.fn(),
    children: <p>body content</p>,
    ...over,
  }
  render(<Modal {...props} />)
  return props
}

describe('Modal', () => {
  it('names itself and shows what it was given', () => {
    show()

    expect(screen.getByRole('heading', { name: 'Withdraw WETH' })).toBeTruthy()
    expect(screen.getByText('body content')).toBeTruthy()
  })

  it('closes from the header button', () => {
    const props = show()

    fireEvent.click(screen.getByRole('button', { name: /close/i }))

    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('closes when the backdrop is clicked', () => {
    // Three of the modals had this and three did not, so the same gesture dismissed some screens
    // and did nothing on others.
    const props = show()

    fireEvent.click(screen.getByTestId('modal-overlay'))

    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('stays open when the click is inside it', () => {
    // The backdrop handler fires for every click that bubbles to it, so it has to check the target.
    const props = show()

    fireEvent.click(screen.getByText('body content'))

    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    // None of them did this before. A modal that traps a keyboard user is the accessibility floor.
    const props = show()

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('announces itself as a dialog', () => {
    show()

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe('Withdraw WETH')
  })

  it('takes a footer when a screen has actions, and renders none when it does not', () => {
    const { unmount } = render(
      <Modal title="Confirm" onClose={vi.fn()} footer={<button>Send</button>}>
        <p>body</p>
      </Modal>,
    )
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
    unmount()

    const { container } = render(
      <Modal title="Confirm" onClose={vi.fn()}>
        <p>body</p>
      </Modal>,
    )
    expect(container.querySelector('.modal-footer')).toBeNull()
  })

  it('can hold a wider screen than the default', () => {
    // The asset pickers are tables and need the room; the amount forms are narrow on purpose.
    const { container } = render(
      <Modal title="Assets to supply" onClose={vi.fn()} maxWidth="600px">
        <p>body</p>
      </Modal>,
    )

    expect(container.querySelector<HTMLElement>('.modal-content')?.style.maxWidth).toBe('600px')
  })

  it('lets a screen suppress its own dismissal', () => {
    // A transaction with the wallet must not be dismissable by a stray backdrop click.
    const props = show({ dismissable: false })

    fireEvent.click(screen.getByTestId('modal-overlay'))
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(props.onClose).not.toHaveBeenCalled()
    // The button stays, so there is always a deliberate way out.
    expect(screen.getByRole('button', { name: /close/i })).toBeTruthy()
  })
})

describe('modal widths', () => {
  it('offers a width per kind of content, not per screen', async () => {
    const { MODAL_WIDTH } = await import('../styles/theme')

    // Named so that two screens showing the same thing cannot end up different sizes — which is
    // what happened when the asset pickers rendered the withdraw modal's form at list width.
    expect(MODAL_WIDTH.form).toBe('440px')
    expect(MODAL_WIDTH.confirm).toBe('500px')
    expect(MODAL_WIDTH.list).toBe('600px')
  })

  it('applies the width it is given', () => {
    const { container } = render(
      <Modal title="Assets to supply" onClose={vi.fn()} maxWidth="600px">
        <p>body</p>
      </Modal>,
    )

    expect(container.querySelector<HTMLElement>('.modal-content')?.style.maxWidth).toBe('600px')
  })
})
