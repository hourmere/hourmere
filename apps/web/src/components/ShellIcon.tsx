import type { ReactNode } from 'react'

const paths = {
  event: <path d="M5 4h10l4 4v12H5z M14 4v5h5 M8 14h8 M8 17h5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  booking: <path d="M4 6h16v14H4z M4 10h16 M8 4v4 M16 4v4 M9 15l2 2 4-4" />,
  poll: <path d="M4 4h16v13H9l-5 4z M8 8v5 M12 10v3 M16 7v6" />,
  workflow: <path d="M4 4h6v6H4z M14 14h6v6h-6z M7 10v7h7 M13 7h7 M17 4l3 3-3 3" />,
  team: (
    <>
      <circle cx="10" cy="8" r="3" />
      <path d="M4 20v-2a6 6 0 0 1 12 0v2 M16 5a3 3 0 0 1 0 6 M20 20v-2a6 6 0 0 0-3-5" />
    </>
  ),
  activity: <path d="M4 19h16 M6 15v-3 M12 15V8 M18 15V5" />,
  camera: <path d="M3 6h12v12H3z M15 10l6-4v12l-6-4" />,
  calendar: <path d="M4 6h16v14H4z M4 10h16 M8 4v4 M16 4v4 M8 14h2 M14 14h2 M8 17h2" />,
  key: (
    <>
      <circle cx="8" cy="9" r="4" />
      <path d="m11 12 8 8 M16 17l2-2 M18 19l2-2" />
    </>
  ),
  plug: <path d="M8 4v5 M16 4v5 M6 9h12v2a6 6 0 0 1-12 0z M12 17v3" />,
  audit: <path d="M7 6H4v14h16V6h-3 M8 4h8v4H8z M8 12h8 M8 16h5" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M9 4h6l1 3 3 1 2 4-2 4-3 1-1 3H9l-1-3-3-1-2-4 2-4 3-1z" />
    </>
  ),
  routing: <path d="M5 12h5m0 0 4-6h5m-9 6 4 6h5m-3-15 3 3-3 3m0 6 3 3-3 3" />,
  chevron: <path d="m7 10 5 5 5-5" />,
} satisfies Record<string, ReactNode>

export type ShellIconName = keyof typeof paths

export function ShellIcon({ name }: { name: ShellIconName }) {
  return (
    <svg
      className="shell-icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  )
}
