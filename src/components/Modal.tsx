/**
 * The one modal shell.
 *
 * There were three conventions before this. Three screens composed `modalStyle`,
 * `modalHeaderStyle` and `closeButtonStyle` from the theme and closed on a backdrop click; two used
 * the `.modal-header` / `.modal-body` / `.modal-footer` classes in `index.css` and did not; one
 * hard-coded `#fff` and `#111` and had no theme involvement at all. So the same gesture dismissed
 * some screens and did nothing on others, `×` appeared on some and not others, and Escape worked
 * nowhere.
 *
 * Composed from what already existed rather than replacing it: the theme's style objects and the
 * stylesheet's class names are both still the source of the appearance. What this adds is a single
 * place for the behaviour around them.
 */
import { useEffect, type ReactNode } from 'react'
import { closeButtonStyle, modalHeaderStyle, modalStyle, modalTitleStyle } from '../styles/theme'

export interface ModalProps {
  /** Names the dialog, both on screen and to a screen reader. */
  title: ReactNode
  onClose: () => void
  children: ReactNode
  /** Actions. Omitted entirely for a screen that is only read. */
  footer?: ReactNode
  /** One of {@link MODAL_WIDTH}. Falls back to the theme's own default when omitted. */
  maxWidth?: string
  /**
   * Whether a backdrop click or Escape may dismiss it. Default true.
   *
   * False for a screen mid-transaction: losing the report of a send to a stray click outside it is
   * how a user ends up not knowing whether their money moved. The header button always remains, so
   * there is a deliberate way out either way.
   */
  dismissable?: boolean
  /** For the rare screen whose title needs its own layout, such as a settled state's tick. */
  headerAside?: ReactNode
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  maxWidth,
  dismissable = true,
  headerAside,
}: ModalProps) {
  useEffect(() => {
    if (!dismissable) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dismissable, onClose])

  return (
    <div
      className="modal-overlay"
      data-testid="modal-overlay"
      // Target-checked, because this handler receives every click that bubbles out of the body.
      onClick={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="modal-content"
        style={{ ...modalStyle, ...(maxWidth ? { maxWidth } : null) }}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        <div className="modal-header" style={modalHeaderStyle}>
          <h2 style={{ ...modalTitleStyle, flex: 1 }}>{title}</h2>
          {headerAside}
          <button type="button" onClick={onClose} aria-label="Close" title="Close" style={closeButtonStyle}>
            ×
          </button>
        </div>

        {/* Scrolls on its own so a long form cannot push the footer off a short viewport. */}
        <div className="modal-body" style={{ flex: 1, overflowY: 'auto' }}>
          {children}
        </div>

        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}
