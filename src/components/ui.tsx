'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * clsx picks the classes, tailwind-merge decides the winner when two of them set
 * the same property. Without the merge, a caller passing `p-5` to something that
 * already says `p-6` gets whichever Tailwind emitted last, which is not the one
 * they asked for.
 */
const cn = (...parts: ClassValue[]) => twMerge(clsx(parts));

/**
 * The handful of shapes the dashboard reuses. Deliberately small — this is an
 * internal tool for one person, and a component library would be more code to
 * maintain than the app it dresses.
 *
 * These are the only places the brand's SHAPE lives: square edges, hard rules,
 * a black control that turns accent-blue under the cursor. Its COLOURS come
 * from the repainted zinc ramp in globals.css, which is why almost none of the
 * class names below changed when the design did.
 *
 * Colours are written out rather than driven by the light/dark variables in
 * globals.css. The public listicle pages follow the visitor's system theme; the
 * dashboard should look the same at 9pm as it did at 9am.
 */

export function Button({
  children, variant = 'primary', className, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  return (
    <button
      {...rest}
      className={cn(
        'font-display inline-flex items-center justify-center gap-2 rounded-[var(--radius-brand)]',
        'px-6 py-3 text-base font-semibold tracking-[-0.01em]',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        // The comp's one interaction signature: the black control goes blue
        // rather than grey, on every direction and every screen.
        variant === 'primary' && 'bg-zinc-900 text-white hover:bg-accent disabled:hover:bg-zinc-900',
        variant === 'ghost' && 'border-[1.5px] border-zinc-900 bg-white text-zinc-900 hover:bg-zinc-50',
        variant === 'danger' && 'bg-red-600 text-white hover:bg-red-500',
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * A labelled input with its help text always visible, never on hover or focus.
 * The help is where the screen explains itself, so hiding it defeats the point.
 */
export function Field({
  label, help, error, children,
}: { label: string; help?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className="block">
      <span className="font-display block text-base font-semibold tracking-[-0.01em] text-zinc-900">
        {label}
      </span>
      {help ? <span className="mt-1 block text-sm leading-6 text-zinc-500">{help}</span> : null}
      <div className="mt-2">{children}</div>
      {error ? <span className="mt-2 block text-sm font-medium text-red-600">{error}</span> : null}
    </label>
  );
}

export const inputClass = 'w-full rounded-[var(--radius-brand)] border-2 border-zinc-900 bg-white '
  + 'px-4 py-3 text-base text-zinc-900 placeholder:text-zinc-400 '
  + 'focus:border-accent focus:outline-none';

export function Callout({
  tone = 'info', title, children,
}: { tone?: 'info' | 'warn' | 'error' | 'good'; title?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        // A square block with one heavy edge on the reading side, rather than a
        // rounded tinted pill. The comp has no callouts of its own, so this is
        // the brand's rules applied to a shape it does not specify: hard
        // corners, a hairline box, and the tone carried by the edge.
        'rounded-[var(--radius-brand)] border border-l-4 px-4 py-3 text-sm leading-6',
        tone === 'info' && 'border-zinc-200 border-l-accent bg-zinc-50 text-zinc-700',
        tone === 'warn' && 'border-amber-200 border-l-amber-500 bg-amber-50 text-amber-900',
        tone === 'error' && 'border-red-200 border-l-red-600 bg-red-50 text-red-900',
        tone === 'good' && 'border-emerald-200 border-l-emerald-600 bg-emerald-50 text-emerald-900',
      )}
    >
      {title ? <p className="font-display font-semibold tracking-[-0.01em]">{title}</p> : null}
      <div className={title ? 'mt-1' : undefined}>{children}</div>
    </div>
  );
}

/**
 * `dash` is what scopes the display typeface — see the note in globals.css. It
 * belongs here because every signed-in screen goes through this wrapper and no
 * public /p/ page does.
 *
 * `header` exists so the masthead can run the full width of the window while
 * the reading column stays at its measure. The comp puts the wordmark on a
 * solid black field, and a black field that stops at a 672px column reads as a
 * box rather than as chrome. Sign-in passes nothing and gets no masthead.
 */
export function Shell({ header, children }: { header?: ReactNode; children: ReactNode }) {
  return (
    <div className="dash min-h-full flex-1 bg-white text-zinc-900">
      {header}
      <div className="mx-auto w-full max-w-2xl px-5 py-10 sm:py-14">{children}</div>
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'rounded-[var(--radius-brand-card)] border-[1.5px] border-zinc-900 bg-white p-6 sm:p-8',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Copies text and says so, because a button that does nothing visible reads as broken. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  return (
    <button
      type="button"
      onClick={async (e) => {
        const el = e.currentTarget;
        try {
          await navigator.clipboard.writeText(text);
          const was = el.textContent;
          el.textContent = 'Copied';
          setTimeout(() => { el.textContent = was; }, 1500);
        } catch {
          el.textContent = 'Press Cmd+C';
        }
      }}
      className="font-display shrink-0 rounded-[var(--radius-brand)] border-[1.5px] border-zinc-900
                 bg-white px-3 py-1.5 text-sm font-semibold text-zinc-900 hover:bg-zinc-900
                 hover:text-white"
    >
      {label}
    </button>
  );
}
