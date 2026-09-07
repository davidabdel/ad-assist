import type { PublicPage } from '@/lib/page-data';
import { NEUTRAL_BRAND, brandVars, googleFontsHref } from '@/lib/brand';
import { spec } from '@/lib/product-type';
import { CtaLink } from './CtaLink';
import { EnquiryForm } from './EnquiryForm';

/**
 * The listicle. 80% of this is locked across all 20 persona pages — layout,
 * offer block, footer, checkout trigger. The persona only swaps the top bar,
 * the H1, reasons 1-3, their pictures and the proof quote, and that swap
 * already happened in Postgres before this component saw the data.
 *
 * IT WEARS THE SELLER'S BRAND, NOT OURS. Colours, type, logo and the browser
 * tab icon all come off their own website, because the page and the checkout
 * are one journey: a buyer who is persuaded here and then lands in a shop that
 * looks like a different company has been handed a reason to stop. Everything
 * brandable is a CSS variable set once on the wrapper (see lib/brand.ts), so a
 * campaign with no readable brand renders in the neutral editorial theme
 * through the same code path rather than a second one.
 *
 * WHAT IS DELIBERATELY NOT BRANDED: the structure. Numbered reasons, an article
 * measure, long copy, no product grid. That shape is why a listicle beats a
 * product page in a cold feed, and repainting it does not touch it.
 *
 * `preview` DRAWS THE EMPTY PICTURE SLOTS. It is on for the un-personalised
 * base page, which is the operator's proof sheet, and OFF for every live
 * persona URL. That split is the whole point: the base page has to show where
 * pictures go before there are any, and a real ad destination must never show a
 * dashed box to a buyer. An unfilled slot on a live page renders as nothing.
 */
/**
 * An empty picture slot, drawn at roughly the proportions a real photo will
 * take so the page reads at its finished length rather than its current one.
 * Preview only — see the note on `Listicle`.
 */
function Slot({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      className="mt-5 flex min-h-32 flex-col justify-center rounded-[var(--brand-radius)] border-2 border-dashed px-5 py-6"
      style={{ borderColor: 'var(--brand-rule)', background: 'var(--brand-tint)' }}
    >
      <p
        className="text-[0.7rem] font-semibold uppercase tracking-[0.16em]"
        style={{ color: 'var(--brand-primary)', opacity: 0.65 }}
      >
        {label}
      </p>
      <p className="mt-1.5 text-sm leading-relaxed" style={{ color: 'var(--brand-muted)' }}>
        {children}
      </p>
    </div>
  );
}

export function Listicle({ page, preview = false }: { page: PublicPage; preview?: boolean }) {
  const personaId = page.persona_id;
  const brand = page.brand ?? NEUTRAL_BRAND;
  const fonts = googleFontsHref(brand);
  // A vehicle has no cart: there is one of it and the buyer rings. So the same
  // offer block ends in a phone number and a form instead of a checkout link,
  // and the sticky bar becomes tap-to-call. Everything else on the page — the
  // ten reasons, the 80/20 persona merge, the brand — is unchanged, because
  // none of it depends on how the sale closes.
  const contact = spec(page.product_type ?? 'ecom').ctaKind === 'contact';

  return (
    <div
      className="min-h-screen"
      style={{
        ...brandVars(brand),
        background: 'var(--brand-surface)',
        color: 'var(--brand-ink)',
        fontFamily: 'var(--brand-body-font)',
      }}
    >
      {/* React hoists this into <head>. It is only ever a family the seller's
          own site already loads from Google, so it adds their typeface and
          never invents one. The browser-tab icon is NOT set here — it is set
          through the route's metadata, where it can override the app's own
          favicon rather than race it. */}
      {fonts ? <link rel="stylesheet" href={fonts} /> : null}

      {page.topbar ? (
        <div
          className="sticky top-0 z-50 px-4 py-2.5 text-center text-sm font-medium tracking-wide"
          style={{ background: 'var(--brand-primary)', color: 'var(--brand-on-primary)' }}
        >
          {page.topbar}
        </div>
      ) : null}

      {/* The single strongest continuity cue, and the reason it is a plain
          <img> at a fixed height rather than a layout: whatever shape their
          mark is, it has to look like the one above their checkout. */}
      {brand.logo_url ? (
        <div
          className="border-b px-5 py-4 text-center"
          style={{ borderColor: 'var(--brand-rule)' }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={brand.logo_url}
            alt={brand.site_name ?? ''}
            className="mx-auto h-9 w-auto object-contain sm:h-10"
          />
        </div>
      ) : null}

      <article className="mx-auto max-w-2xl px-5 pb-40 pt-10 sm:pt-14">
        <header>
          <p
            className="mb-3 text-xs font-semibold uppercase tracking-[0.18em]"
            style={{ color: 'var(--brand-primary)' }}
          >
            Buyer&rsquo;s Guide
          </p>
          <h1
            className="text-3xl leading-[1.15] tracking-tight sm:text-[2.75rem]"
            style={{ fontFamily: 'var(--brand-heading-font)' }}
          >
            {page.headline}
          </h1>
          {page.subheadline ? (
            <p className="mt-5 text-lg leading-relaxed" style={{ color: 'var(--brand-muted)' }}>
              {page.subheadline}
            </p>
          ) : null}

          {page.hero_image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={page.hero_image_url}
              alt={page.hero_image_alt ?? ''}
              className="mt-7 w-full rounded-[var(--brand-radius)] border"
              style={{ borderColor: 'var(--brand-rule)' }}
            />
          ) : preview ? (
            <Slot label="Hero picture">
              The widest, most human photo from the product page goes here.
            </Slot>
          ) : null}
        </header>

        <hr className="my-10 border-0 border-t" style={{ borderColor: 'var(--brand-rule)' }} />

        <ol className="space-y-12">
          {page.reasons?.map((r, i) => (
            <li key={r.number ?? i} className="grid grid-cols-[2.5rem_1fr] gap-x-4">
              <span
                aria-hidden
                className="text-3xl leading-none"
                style={{
                  fontFamily: 'var(--brand-heading-font)',
                  color: 'var(--brand-primary)',
                  opacity: 0.4,
                }}
              >
                {String(r.number ?? i + 1).padStart(2, '0')}
              </span>
              <div>
                <h2
                  className="text-xl leading-snug sm:text-2xl"
                  style={{ fontFamily: 'var(--brand-heading-font)' }}
                >
                  {r.title}
                </h2>
                <p className="mt-3 leading-relaxed">{r.body}</p>
                {r.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={r.image_url}
                    alt={r.image_alt ?? ''}
                    loading="lazy"
                    className="mt-5 w-full rounded-[var(--brand-radius)] border"
                    style={{ borderColor: 'var(--brand-rule)' }}
                  />
                ) : preview ? (
                  <Slot label={`Picture for reason ${r.number ?? i + 1}`}>
                    {r.image_prompt?.trim() || 'No picture planned for this reason.'}
                  </Slot>
                ) : null}
              </div>
            </li>
          ))}
        </ol>

        {page.testimonials?.length ? (
          <section
            className="mt-16 space-y-5 rounded-[var(--brand-radius)] p-6 sm:p-8"
            style={{ background: 'var(--brand-tint)' }}
          >
            <p
              className="text-xs font-semibold uppercase tracking-[0.18em]"
              style={{ color: 'var(--brand-primary)' }}
            >
              What buyers say
            </p>
            {page.testimonials.slice(0, 3).map((t, i) => (
              <figure
                key={i}
                className="border-l-2 pl-4"
                style={{ borderColor: 'var(--brand-accent)' }}
              >
                <blockquote
                  className="text-lg leading-relaxed"
                  style={{ fontFamily: 'var(--brand-heading-font)' }}
                >
                  &ldquo;{t.quote}&rdquo;
                </blockquote>
                {t.reviewer ? (
                  <figcaption className="mt-2 text-sm" style={{ color: 'var(--brand-muted)' }}>
                    — {t.reviewer}
                    {t.rating ? ` · ${t.rating}/5` : ''}
                  </figcaption>
                ) : null}
              </figure>
            ))}
          </section>
        ) : null}

        <section
          className="mt-16 rounded-[var(--brand-radius)] border-2 p-6 text-center sm:p-10"
          style={{ borderColor: 'var(--brand-primary)' }}
        >
          <h2
            className="text-2xl leading-tight sm:text-3xl"
            style={{ fontFamily: 'var(--brand-heading-font)' }}
          >
            {page.offer_headline}
          </h2>
          {page.offer_body ? (
            <p
              className="mx-auto mt-4 max-w-md leading-relaxed"
              style={{ color: 'var(--brand-muted)' }}
            >
              {page.offer_body}
            </p>
          ) : null}
          {/* On a contact page this is the tap-to-call. The number is IN the
              button rather than beside it: a buyer on a desktop cannot tap it,
              and a button that reads "Call about this one" with no digits
              anywhere is a dead end on the device half of them are using. */}
          <CtaLink
            href={page.cta_url}
            personaId={personaId}
            className="mt-7 inline-block w-full rounded-[var(--brand-radius)] px-8 py-4 text-base font-semibold transition hover:opacity-90 sm:w-auto"
            style={{ background: 'var(--brand-accent)', color: 'var(--brand-on-accent)' }}
          >
            {contact && page.contact_phone
              ? `${page.cta_button_text} · ${page.contact_phone}`
              : page.cta_button_text}
          </CtaLink>

          {contact ? (
            <EnquiryForm
              campaignId={page.campaign_id}
              personaId={personaId}
              phone={page.contact_phone}
            />
          ) : null}
        </section>
      </article>

      {/* Sticky CTA. On a long listicle the buyer decides somewhere in the middle,
          and making them scroll to the bottom to act is where the conversion goes. */}
      <div
        className="fixed inset-x-0 bottom-0 z-50 border-t p-3 backdrop-blur"
        style={{
          borderColor: 'var(--brand-rule)',
          background: 'color-mix(in srgb, var(--brand-surface) 95%, transparent)',
        }}
      >
        <CtaLink
          href={page.cta_url}
          personaId={personaId}
          className="mx-auto block max-w-md rounded-[var(--brand-radius)] px-6 py-3.5 text-center text-base font-semibold transition hover:opacity-90"
          style={{ background: 'var(--brand-accent)', color: 'var(--brand-on-accent)' }}
        >
          {contact && page.contact_phone
            ? `${page.cta_button_text} · ${page.contact_phone}`
            : page.cta_button_text}
        </CtaLink>
      </div>
    </div>
  );
}
