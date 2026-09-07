'use client';

import type { CSSProperties, ReactNode } from 'react';

/**
 * Counts the click, then leaves. sendBeacon rather than await-then-navigate:
 * a tracking call must never sit between a buyer pressing Buy and the cart
 * loading, and a beacon survives the page unload that follows.
 */
export function CtaLink({
  href, personaId, className, style, children,
}: {
  href: string;
  personaId: string | null;
  className?: string;
  /** The brand's button colours. Inline because they are per-campaign values. */
  style?: CSSProperties;
  children: ReactNode;
}) {
  function onClick() {
    if (!personaId) return;
    try {
      navigator.sendBeacon?.(
        '/api/track/click',
        new Blob([JSON.stringify({ personaId })], { type: 'application/json' }),
      );
    } catch {
      // Never block the click on a failed count.
    }
  }

  return (
    <a href={href} onClick={onClick} className={className} style={style} rel="noopener">
      {children}
    </a>
  );
}
