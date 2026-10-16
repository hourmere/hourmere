import mark from '../assets/hourmere-mark.svg'
import markWhite from '../assets/hourmere-mark-white.svg'

/** The Hourmere mark and wordmark (the website's assets), light or dark with the system. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span className="logo">
      <picture>
        <source srcSet={markWhite} media="(prefers-color-scheme: dark)" />
        <img src={mark} width={size} height={size} alt="" />
      </picture>
      <span className="logo-word">Hourmere</span>
    </span>
  )
}
