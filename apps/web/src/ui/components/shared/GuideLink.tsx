/**
 * A quiet `?` beside a screen element that opens the Guide page explaining it. Take `path` from
 * `GUIDE_SCREEN_PAGES` (`@rocketpod/shared/guide-screens`), the one screen → topic map, rather than
 * writing a page path inline — the staleness test holds those to real pages every member can read.
 * With `children` it is a quiet text link (icon + words) instead of the bare icon.
 */

import { QuestionMarkCircleIcon } from '@heroicons/react/24/outline'
import { guideHref } from '@rocketpod/shared/guide'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

export function GuideLink({
  path,
  heading,
  label = 'Read about this in the Guide',
  className = '',
  children,
}: {
  path: string
  heading?: string
  label?: string
  className?: string
  /** Visible words beside the icon; the link is then named by them, not by `label`. */
  children?: ReactNode
}) {
  return (
    <Link
      to={guideHref(path, heading)}
      aria-label={children ? undefined : label}
      title={label}
      className={`inline-flex items-center gap-1 text-muted transition-colors hover:text-accent ${className}`}
    >
      <QuestionMarkCircleIcon
        className="h-4 w-4 shrink-0"
        aria-hidden={children ? true : undefined}
      />
      {children}
    </Link>
  )
}
