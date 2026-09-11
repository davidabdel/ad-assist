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
export const cn = (...parts: ClassValue[]) => twMerge(clsx(parts));

/**
 * The handful of shapes the dashboard reuses. Deliberately small — a component
 * library would be more code to maintain than the app it dresses.
 *
 * These are the only places the brand's SHAPE lives: navy pills that turn
 * accent-blue under the cursor, soft 12px inputs, tinted callouts. Its COLOURS
 * come from the repainted zinc ramp in globals.css, which is why most class
 * names elsewhere did not change when the design did.
 *
 * Colours are written out rather than driven by the light/dark variables in
 * globals.css. The public listicle pages follow the visitor's system theme; the
 * dashboard should look the same at 9pm as it did at 9am.
 */

export function Button({
  children, variant = 'primary', className, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'gradient' | 'ghost' | 'danger';
}) {
  return (
    <button
      {...rest}
      className={cn(
        'inline-flex items-center justify-center gap-2.5 rounded-[var(--radius-brand)]',
        'px-6 py-3.5 text-[15px] font-bold',
        'transition-[background-color,border-color,color,filter] disabled:cursor-not-allowed disabled:opacity-40',
        // The one interaction signature: navy goes blue under the cursor.
        variant === 'primary' && 'bg-zinc-900 text-white hover:bg-accent disabled:hover:bg-zinc-900',
        variant === 'gradient' && 'bg-brand-gradient font-extrabold text-white '
          + 'shadow-[0_10px_24px_-10px_rgba(8,125,232,.7)] hover:brightness-[1.06]',
        variant === 'ghost' && 'border-[1.5px] border-zinc-300 bg-white text-zinc-900 hover:border-zinc-900',
        variant === 'danger' && 'bg-[#C2410C] text-white hover:bg-[#9A3412]',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Back, Cancel, Change — the actions that should not compete with Next. */
export function TextButton({
  children, className, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        'px-1.5 py-3 text-[15px] font-semibold text-zinc-500 hover:text-zinc-900 disabled:opacity-40',
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
      <span className="block text-sm font-bold text-zinc-900">{label}</span>
      <div className="mt-2">{children}</div>
      {error
        ? <span className="mt-2 block text-[13px] font-medium leading-normal text-[#C2410C]">{error}</span>
        : help
          ? <span className="mt-2 block text-[13px] leading-normal text-zinc-400">{help}</span>
          : null}
    </label>
  );
}

export const inputClass = 'w-full rounded-xl border-2 border-zinc-300 bg-white '
  + 'px-4 py-3.5 text-[15px] font-medium text-zinc-900 placeholder:text-[#9AA4B2] '
  + 'transition-colors focus:border-accent focus:outline-none '
  + 'aria-[invalid=true]:border-[#F97316]';

export function Callout({
  tone = 'info', title, children,
}: { tone?: 'info' | 'warn' | 'error' | 'good'; title?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'flex items-start gap-3.5 rounded-[var(--radius-brand-card)] border px-[18px] py-4 text-sm leading-[1.55]',
        tone === 'info' && 'border-[#D6E8FB] bg-accent-tint text-zinc-900',
        tone === 'warn' && 'border-[#F3D9BC] bg-amber-tint text-[#7A3B07]',
        tone === 'error' && 'border-[#F6D6BE] bg-[#FDF3EC] text-[#9A3412]',
        tone === 'good' && 'border-teal-line bg-teal-tint text-zinc-900',
      )}
    >
      {tone === 'good' ? (
        <span className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-teal text-[13px] font-extrabold text-white">
          ✓
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        {title ? <p className="font-bold">{title}</p> : null}
        <div className={title ? 'mt-1' : undefined}>{children}</div>
      </div>
    </div>
  );
}

/** The mark and the wordmark, as every screen but the footer wears them. */
export function Logo({ size = 36, onDark = false }: { size?: number; onDark?: boolean }) {
  return (
    <span className="flex items-center gap-2.5 whitespace-nowrap">
      {/* eslint-disable-next-line @next/next/no-img-element -- a 36px static mark; next/image buys nothing here */}
      <img src="/brand/adtocart-icon.png" alt="" style={{ height: size, width: 'auto' }} className="block" />
      <span
        className={cn('font-extrabold tracking-[-0.03em]', onDark ? 'text-white' : 'text-zinc-900')}
        style={{ fontSize: Math.round(size * 0.62) }}
      >
        adtocart<span className="text-zinc-400">.cc</span>
      </span>
    </span>
  );
}

/**
 * `dash` scopes the heading rules in globals.css. It belongs here because every
 * signed-in screen goes through this wrapper and no public /p/ page does.
 *
 * `header` runs the full width of the window while the reading column stays at
 * its measure. `wide` is for the campaign screen, whose build view and ideas
 * table need the room.
 */
export function Shell({
  header, wide = false, children,
}: { header?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <div className="dash min-h-full flex-1 bg-white text-zinc-900">
      {header}
      <div
        className={cn(
          'mx-auto w-full px-5 py-10 sm:px-11 sm:py-14',
          wide ? 'max-w-[1240px]' : 'max-w-[808px]',
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-zinc-200 bg-white p-6 shadow-[0_30px_60px_-40px_rgba(6,22,46,.35)] sm:p-8',
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
      className="shrink-0 rounded-[var(--radius-brand)] border-[1.5px] border-zinc-300
                 bg-white px-3.5 py-1.5 text-[13px] font-bold text-zinc-900 hover:border-zinc-900"
    >
      {label}
    </button>
  );
}
