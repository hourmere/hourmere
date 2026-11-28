const cobalt = '#1f4fd8'
const cobaltStrong = '#1a43b8'
const deepMere = '#0a1e4a'
const mist = '#eaf0fd'
const ink = '#0e1015'
const danger = '#b42318'

/** Default values keyed by their CSS custom properties. */
export const tokens = {
  // Brand
  '--hm-color-cobalt': cobalt,
  '--hm-color-cobalt-strong': cobaltStrong,
  '--hm-color-deep-mere': deepMere,
  '--hm-color-mist': mist,
  '--hm-color-amber': '#f2a33a', // graphics only, never text
  '--hm-color-ink': ink,
  // Roles
  '--hm-color-bg': '#f7f9fe',
  '--hm-color-surface': '#ffffff',
  '--hm-color-surface-muted': mist,
  '--hm-color-text': ink,
  '--hm-color-muted': '#475066',
  '--hm-color-border': '#d6deef',
  '--hm-color-border-strong': '#7a8ab0', // 3:1 or more against the light backgrounds (form borders)
  '--hm-color-link': cobalt,
  '--hm-color-accent': cobalt,
  '--hm-color-accent-hover': cobaltStrong,
  '--hm-color-accent-text': '#ffffff',
  '--hm-color-accent-soft': mist,
  '--hm-color-accent-soft-text': deepMere,
  '--hm-color-danger': danger,
  '--hm-color-danger-hover': '#912018',
  '--hm-color-danger-text': '#ffffff',
  '--hm-color-danger-soft': '#fef0ee',
  '--hm-color-danger-border': '#f4b8b0',
  '--hm-color-success-soft': '#ecf8f1',
  '--hm-color-success-border': '#9fd8b8',
  '--hm-color-success-text': '#11603a', // 7:1 on --success-soft
  '--hm-color-error-text': danger, // 6:1 on white and on --danger-soft
  '--hm-color-focus': cobalt,
  // Type, shape, space
  '--hm-font-sans': 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  '--hm-font-mono': 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
  '--hm-text-xs': '0.8125rem',
  '--hm-text-sm': '0.875rem',
  '--hm-text-md': '1rem',
  '--hm-text-lg': '1.125rem',
  '--hm-text-xl': '1.5rem',
  '--hm-text-2xl': '1.75rem',
  '--hm-radius': '10px',
  '--hm-radius-small': '6px',
  '--hm-space-1': '4px',
  '--hm-space-2': '8px',
  '--hm-space-3': '12px',
  '--hm-space-4': '16px',
  '--hm-space-5': '24px',
  '--hm-space-6': '32px',
  '--hm-space-7': '48px',
  '--hm-shadow': '0 1px 2px rgb(14 16 21 / 6%), 0 2px 8px rgb(14 16 21 / 6%)',
} as const

/** Overrides for the system dark theme. Other tokens keep their default values. */
export const darkTokens = {
  '--hm-color-bg': ink,
  '--hm-color-surface': '#151c2e',
  '--hm-color-surface-muted': '#111a33',
  '--hm-color-text': '#e9edf7',
  '--hm-color-muted': '#a9b3c9',
  '--hm-color-border': '#283252',
  '--hm-color-border-strong': '#64719a',
  '--hm-color-link': '#8faeff',
  '--hm-color-accent': '#3d68e6',
  '--hm-color-accent-hover': '#3360e0',
  '--hm-color-accent-soft': '#16244a',
  '--hm-color-accent-soft-text': '#dbe5ff',
  '--hm-color-danger': '#d13438', // white text 4.9:1
  '--hm-color-danger-hover': danger,
  '--hm-color-danger-soft': '#2c1517',
  '--hm-color-danger-border': '#6b2a2d',
  '--hm-color-success-soft': '#11261c',
  '--hm-color-success-border': '#2b6a4a',
  '--hm-color-success-text': '#9fe0bd',
  '--hm-color-error-text': '#ff9a94', // 7:1 on --surface
  '--hm-color-focus': '#8faeff',
  '--hm-shadow': 'none',
} as const satisfies Partial<Record<keyof typeof tokens, string>>
