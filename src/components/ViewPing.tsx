'use client';

import { useEffect, useRef } from 'react';

/**
 * Counts one view per mount. The ref guard matters: React strict mode double-mounts
 * in development, and without it every local page load would count twice and the
 * click-through rate would read half what it is.
 */
export function ViewPing({ personaId }: { personaId: string | null }) {
  const sent = useRef(false);
  useEffect(() => {
    if (!personaId || sent.current) return;
    sent.current = true;
    fetch('/api/track/view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personaId }),
      keepalive: true,
    }).catch(() => {});
  }, [personaId]);
  return null;
}
