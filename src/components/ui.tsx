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
        'inline-flex items-center justify-center gap-2 rounded-lg px-5 py-3 text-base font-semibold',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        variant === 'primary' && 'bg-zinc-900 text-white hover:bg-zinc-700',
        variant === 'ghost' && 'bg-white text-zinc-700 ring-1 ring-zinc-300 hover:bg-zinc-50',
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
      <span className="block text-base font-semibold text-zinc-900">{label}</span>
      {help ? <span className="mt-1 block text-sm leading-6 text-zinc-500">{help}</span> : null}
      <div className="mt-2">{children}</div>
      {error ? <span className="mt-2 block text-sm font-medium text-red-600">{error}</span> : null}
    </label>
  );
}

export const inputClass = 'w-full rounded-lg border-0 bg-white px-4 py-3 text-base text-zinc-900 '
  + 'ring-1 ring-zinc-300 placeholder:text-zinc-400 focus:ring-2 focus:ring-zinc-900 '
  + 'focus:outline-none';

export function Callout({
  tone = 'info', title, children,
}: { tone?: 'info' | 'warn' | 'error' | 'good'; title?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-lg px-4 py-3 text-sm leading-6 ring-1',
        tone === 'info' && 'bg-zinc-50 text-zinc-700 ring-zinc-200',
        tone === 'warn' && 'bg-amber-50 text-amber-900 ring-amber-200',
        tone === 'error' && 'bg-red-50 text-red-900 ring-red-200',
        tone === 'good' && 'bg-emerald-50 text-emerald-900 ring-emerald-200',
      )}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      <div className={title ? 'mt-1' : undefined}>{children}</div>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-full flex-1 bg-zinc-100 text-zinc-900">
      <div className="mx-auto w-full max-w-2xl px-5 py-10 sm:py-16">{children}</div>
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-2xl bg-white p-6 shadow-sm ring-1 ring-zinc-200 sm:p-8', className)}>
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
      className="shrink-0 rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-semibold text-zinc-700
                 ring-1 ring-zinc-300 hover:bg-zinc-200"
    >
      {label}
    </button>
  );
}
