import type { PublicPage } from '@/lib/page-data';
import { CtaLink } from './CtaLink';

/**
 * The listicle. 80% of this is locked across all 20 persona pages — layout,
 * offer block, footer, checkout trigger. The persona only swaps the top bar,
 * the H1, reasons 1-3 and the proof quote, and that swap already happened in
 * Postgres before this component saw the data.
 *
 * Editorial rather than "landing page": serif headlines against sans body is
 * what makes a listicle read as an article instead of an ad, which is the whole
 * reason this format outperforms a product page in a cold feed.
 */
export function Listicle({ page }: { page: PublicPage }) {
  const personaId = page.persona_id;

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      {page.topbar ? (
        <div className="sticky top-0 z-50 bg-neutral-900 px-4 py-2.5 text-center text-sm font-medium tracking-wide text-white">
          {page.topbar}
        </div>
      ) : null}

      <article className="mx-auto max-w-2xl px-5 pb-40 pt-10 sm:pt-14">
        <header>
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">
            Buyer&rsquo;s Guide
          </p>
          <h1 className="font-serif text-3xl leading-[1.15] tracking-tight sm:text-[2.75rem]">
            {page.headline}
          </h1>
          {page.subheadline ? (
            <p className="mt-5 text-lg leading-relaxed text-neutral-600">
              {page.subheadline}
            </p>
          ) : null}
        </header>

        <hr className="my-10 border-neutral-200" />

        <ol className="space-y-12">
          {page.reasons?.map((r, i) => (
            <li key={r.number ?? i} className="grid grid-cols-[2.5rem_1fr] gap-x-4">
              <span
                aria-hidden
                className="font-serif text-3xl leading-none text-neutral-300"
              >
                {String(r.number ?? i + 1).padStart(2, '0')}
              </span>
              <div>
                <h2 className="font-serif text-xl leading-snug sm:text-2xl">
                  {r.title}
                </h2>
                <p className="mt-3 leading-relaxed text-neutral-700">{r.body}</p>
                {r.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={r.image_url}
                    alt=""
                    loading="lazy"
                    className="mt-5 w-full rounded-lg border border-neutral-200"
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ol>

        {page.testimonials?.length ? (
          <section className="mt-16 space-y-5 rounded-xl bg-neutral-50 p-6 sm:p-8">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">
              What buyers say
            </p>
            {page.testimonials.slice(0, 3).map((t, i) => (
              <figure key={i} className="border-l-2 border-neutral-300 pl-4">
                <blockquote className="font-serif text-lg leading-relaxed">
                  &ldquo;{t.quote}&rdquo;
                </blockquote>
                {t.reviewer ? (
                  <figcaption className="mt-2 text-sm text-neutral-500">
                    — {t.reviewer}
                    {t.rating ? ` · ${t.rating}/5` : ''}
                  </figcaption>
                ) : null}
              </figure>
            ))}
          </section>
        ) : null}

        <section className="mt-16 rounded-xl border-2 border-neutral-900 p-6 text-center sm:p-10">
          <h2 className="font-serif text-2xl leading-tight sm:text-3xl">
            {page.offer_headline}
          </h2>
          {page.offer_body ? (
            <p className="mx-auto mt-4 max-w-md leading-relaxed text-neutral-600">
              {page.offer_body}
            </p>
          ) : null}
          <CtaLink
            href={page.cta_url}
            personaId={personaId}
            className="mt-7 inline-block w-full rounded-lg bg-neutral-900 px-8 py-4 text-base font-semibold text-white transition hover:bg-neutral-700 sm:w-auto"
          >
            {page.cta_button_text}
          </CtaLink>
        </section>
      </article>

      {/* Sticky CTA. On a long listicle the buyer decides somewhere in the middle,
          and making them scroll to the bottom to act is where the conversion goes. */}
      <div className="fixed inset-x-0 bottom-0 z-50 border-t border-neutral-200 bg-white/95 p-3 backdrop-blur">
        <CtaLink
          href={page.cta_url}
          personaId={personaId}
          className="mx-auto block max-w-md rounded-lg bg-neutral-900 px-6 py-3.5 text-center text-base font-semibold text-white transition hover:bg-neutral-700"
        >
          {page.cta_button_text}
        </CtaLink>
      </div>
    </div>
  );
}
