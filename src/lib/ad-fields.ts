/**
 * The buttons Meta actually offers on an ad.
 *
 * A fixed list rather than free text, because this string is not copy — it is a
 * choice from a dropdown in Ads Manager. A model asked for "the call to action"
 * writes "Grab yours today", which is a thing that cannot be selected, and an
 * operator pasting the row in would have to go and find the nearest real one.
 *
 * Its own file, with no dependencies, so the schema, the API route that
 * validates an edit, and the dropdown on the screen can all read the same list
 * without the browser having to import the pipeline's schemas.
 */
export const CTA_LABELS = [
  'Shop Now', 'Learn More', 'Get Offer', 'Sign Up', 'Subscribe', 'Book Now',
  'Get Quote', 'Contact Us', 'Call Now', 'Download', 'Order Now', 'Apply Now',
] as const;

export type CtaLabel = (typeof CTA_LABELS)[number];
