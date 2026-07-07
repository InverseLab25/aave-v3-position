/**
 * Design Tokens — TypeScript mirror of index.css CSS custom properties.
 *
 * Use this whenever you need to reference design tokens in inline styles or
 * in JS logic. For elements that can use className, prefer the CSS classes
 * defined in index.css (e.g. `btn-primary`, `alert-success`, `badge-danger`).
 *
 * Usage:
 *   import { T } from '../styles/theme'
 *   <div style={{ background: T.surface, borderRadius: T.radius.lg }}>…</div>
 */
export const T = {
  // ── Colours ─────────────────────────────────────────────────────────────
  bg:              '#f8fafc',
  surface:         '#ffffff',
  surfaceAlt:      '#f1f5f9',
  border:          '#e2e8f0',
  borderFocus:     '#2563eb',

  text:            '#0f172a',
  textMuted:       '#64748b',
  textSubtle:      '#94a3b8',

  primary:         '#2563eb',
  primaryHover:    '#1d4ed8',
  primaryText:     '#ffffff',

  success:         '#16a34a',
  successBg:       '#f0fdf4',
  successBorder:   '#bbf7d0',

  danger:          '#dc2626',
  dangerBg:        '#fff5f5',
  dangerBorder:    '#fecaca',

  warning:         '#d97706',
  warningBg:       '#fffbeb',
  warningBorder:   '#fde68a',

  overlay:         'rgba(15, 23, 42, 0.55)',

  // ── Border radius ────────────────────────────────────────────────────────
  radius: {
    sm: '4px',   // inline badges, small buttons
    md: '6px',   // inputs, buttons
    lg: '8px',   // cards, modals
    xl: '10px',  // mobile cards
  },

  // ── Shadows ──────────────────────────────────────────────────────────────
  shadow: {
    card:  '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
    modal: '0 8px 32px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.06)',
    sm:    '0 1px 2px rgba(0,0,0,0.05)',
  },

  // ── Spacing ──────────────────────────────────────────────────────────────
  space: {
    1: '4px', 2: '8px', 3: '12px', 4: '16px',
    5: '20px', 6: '24px', 8: '32px',
  },

  // ── Typography ───────────────────────────────────────────────────────────
  font: {
    sans: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
  },

  fontSize: {
    xs:   '0.70rem',   // 11px — labels, badges
    sm:   '0.80rem',   // 13px — secondary copy
    base: '0.875rem',  // 14px — body
    md:   '1rem',      // 16px — inputs, values
    lg:   '1.1rem',    // 18px — section titles
    xl:   '1.25rem',   // 20px — page titles
  },

  // ── Transition ───────────────────────────────────────────────────────────
  transition: 'all 0.18s ease',
} as const

// ── Pre-built style objects ────────────────────────────────────────────────
// Ready-to-spread React style objects for the most common patterns.

/** Full-screen modal backdrop */
export const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0,
  background: T.overlay,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1000, padding: T.space[4],
}

/** White modal panel */
export const modalStyle: React.CSSProperties = {
  background: T.surface,
  border: `1px solid ${T.border}`,
  borderRadius: T.radius.lg,
  width: '90%', maxWidth: '500px',
  maxHeight: '90vh', overflow: 'hidden',
  display: 'flex', flexDirection: 'column',
  boxShadow: T.shadow.modal,
}

/** Modal header bar */
export const modalHeaderStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: `${T.space[4]} ${T.space[5]}`,
  borderBottom: `1px solid ${T.border}`,
}

/** Modal title */
export const modalTitleStyle: React.CSSProperties = {
  margin: 0, fontSize: T.fontSize.lg, fontWeight: 600, color: T.text,
  letterSpacing: '-0.01em',
}

/** Modal close (×) button */
export const closeButtonStyle: React.CSSProperties = {
  background: 'none', border: 'none',
  fontSize: '20px', lineHeight: 1,
  color: T.textMuted, cursor: 'pointer',
  padding: '0 4px', borderRadius: T.radius.sm,
}

/** Scrollable modal body */
export const modalBodyStyle: React.CSSProperties = {
  flex: 1, overflowY: 'auto', padding: T.space[5],
}

/** Standard section label (uppercase, small) */
export const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: T.fontSize.xs, fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: '0.06em',
  color: T.textMuted, marginBottom: T.space[2],
}

/** Text input */
export const inputStyle: React.CSSProperties = {
  width: '100%', padding: `10px 12px`,
  background: T.surfaceAlt,
  border: `1px solid ${T.border}`,
  borderRadius: T.radius.md,
  fontSize: T.fontSize.md,
  color: T.text, outline: 'none',
  boxSizing: 'border-box',
  transition: 'border-color 0.18s',
}

/** Primary CTA button */
export const primaryBtnStyle = (disabled = false): React.CSSProperties => ({
  width: '100%', padding: '10px 16px',
  backgroundColor: disabled ? '#d1d5db' : T.primary,
  color: disabled ? '#9ca3af' : T.primaryText,
  border: 'none', borderRadius: T.radius.md,
  fontSize: T.fontSize.base, fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer',
  transition: T.transition,
})

/** Inline key-value gas / info row */
export const infoRowStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  fontSize: T.fontSize.sm, padding: '2px 0',
}

/** Compact info card (gas, summary) */
export const infoCardStyle: React.CSSProperties = {
  background: T.surfaceAlt,
  border: `1px solid ${T.border}`,
  borderRadius: T.radius.md,
  padding: `${T.space[2]} ${T.space[3]}`,
  marginBottom: T.space[4],
}

/** Alert / status message */
export const alertStyle = (variant: 'success' | 'danger' | 'warning' | 'info'): React.CSSProperties => {
  const map = {
    success: { background: T.successBg, border: `1px solid ${T.successBorder}`, color: '#166534' },
    danger:  { background: T.dangerBg,  border: `1px solid ${T.dangerBorder}`,  color: '#991b1b' },
    warning: { background: T.warningBg, border: `1px solid ${T.warningBorder}`, color: '#92400e' },
    info:    { background: '#eff6ff',   border: '1px solid #bfdbfe',           color: '#1e40af' },
  }
  return {
    ...map[variant],
    padding: `${T.space[2]} ${T.space[3]}`,
    borderRadius: T.radius.md,
    fontSize: T.fontSize.sm, lineHeight: 1.5,
    marginBottom: T.space[4],
  }
}

/** Table column header */
export const thStyle: React.CSSProperties = {
  fontSize: T.fontSize.xs, fontWeight: 500,
  textTransform: 'uppercase', letterSpacing: '0.06em',
  color: T.textMuted,
  padding: `${T.space[2]} ${T.space[2]}`,
  borderBottom: `1px solid ${T.border}`,
}
