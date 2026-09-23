/**
 * Name the ad page on the click that leaves it.
 *
 * Twenty persona pages sell the same thing to twenty different readers, and
 * they all point at one checkout URL. Without this, every sale those pages
 * make is attributed to "the site" and the campaign can never be told which
 * reader actually bought — which is the one thing twenty pages exist to find
 * out.
 *
 * `?src=<persona slug>` rides the click through to the destination. On the
 * seller's own checkout it can be read and stored against the payment; on a
 * destination that has never heard of it, an unknown query parameter is inert.
 * So this is safe to apply to every campaign rather than only the ones wired
 * for it.
 *
 * It is deliberately NOT a redirect through our own domain. A hop costs a
 * measurable slice of buyers on mobile, and it puts our hostname in front of
 * someone mid-purchase from a brand they have just decided to trust.
 */
export function ctaHrefFor(ctaUrl: string, personaSlug?: string | null): string {
  if (!personaSlug) return ctaUrl;

  // A vehicle CTA is `tel:+61…` and the enquiry fallback is `#enquire`.
  // Neither takes a query string, and appending one to a tel: breaks dialling.
  if (!/^https?:\/\//i.test(ctaUrl)) return ctaUrl;

  let url: URL;
  try {
    url = new URL(ctaUrl);
  } catch {
    // An unparseable checkout URL is the operator's problem to fix, not ours
    // to mangle further. Hand it back exactly as it was stored.
    return ctaUrl;
  }

  // Never overwrite one that is already there. An operator who has written
  // ?src= into the checkout URL by hand meant it, and silently replacing it
  // would break attribution in the one case where they were paying attention.
  if (url.searchParams.has('src')) return ctaUrl;

  url.searchParams.set('src', personaSlug);
  return url.toString();
}
