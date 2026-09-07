/**
 * What is being sold, and everything that follows from it.
 *
 * Three kinds of sale reach this app and they are not variations on a theme —
 * they differ in where the facts come from, how many buyers are worth writing
 * for, and how the sale is closed. Left implicit, that difference would leak
 * into the wizard, the API, four prompts and the renderer as five separate
 * `if (vehicle)` branches that drift apart the first time one of them changes.
 *
 * So it is declared once, here, and everything else reads it.
 *
 * ONE THING DELIBERATELY NOT IN THIS TABLE: the copy on the wizard screens.
 * Data belongs here; sentences belong next to the markup they appear in.
 */

export type ProductType = 'ecom' | 'ebook' | 'vehicle';

/** How the operator supplies the facts about the thing. */
export type InputMode = 'url' | 'text' | 'pdf';

/** How the page closes. `checkout` is a link; `contact` is a phone and a form. */
export type CtaKind = 'checkout' | 'contact';

export type ProductTypeSpec = {
  value: ProductType;
  label: string;
  /** One line under the label on the picker. */
  blurb: string;
  /** Which input modes this kind accepts, in the order the tabs appear. */
  modes: InputMode[];
  /**
   * How many buyer pages to write.
   *
   * Twenty for anything with unlimited supply. FIVE for a vehicle, because
   * there is exactly one of it: twenty pages for one Hilux is twenty pages
   * competing for the same sale, and the twentieth persona is a stretch that
   * makes the first five look worse.
   */
  personaTarget: number;
  ctaKind: CtaKind;
  /**
   * True when the operator's own photographs are the only possible source of
   * pictures, so the wizard must insist on them rather than mention them.
   */
  needsUploadedImages: boolean;
};

export const PRODUCT_TYPES: ProductTypeSpec[] = [
  {
    value: 'ecom',
    label: 'Physical product',
    blurb: 'Something you ship, sold from an online shop.',
    modes: ['url', 'text'],
    personaTarget: 20,
    ctaKind: 'checkout',
    needsUploadedImages: false,
  },
  {
    value: 'ebook',
    label: 'Digital ebook',
    blurb: 'A PDF people buy and download. Upload the book itself, or point at its sales page.',
    modes: ['pdf', 'url'],
    personaTarget: 20,
    ctaKind: 'checkout',
    needsUploadedImages: false,
  },
  {
    value: 'vehicle',
    label: 'Motor vehicle or boat',
    blurb: 'One specific car, ute, bike, caravan or vessel for sale. Buyers ring you.',
    modes: ['url', 'text'],
    personaTarget: 5,
    ctaKind: 'contact',
    needsUploadedImages: true,
  },
];

export function spec(type: ProductType): ProductTypeSpec {
  const found = PRODUCT_TYPES.find((t) => t.value === type);
  if (!found) throw new Error(`unknown product type "${type}"`);
  return found;
}

export const PRODUCT_TYPE_VALUES = PRODUCT_TYPES.map((t) => t.value) as [
  ProductType, ...ProductType[],
];

/**
 * What each kind of thing changes about extraction, appended to the brief
 * prompt. Written as rules rather than description because the failure they
 * prevent is the model helpfully filling in what the source does not say — the
 * spec of the model line instead of the spec of the actual car, a category
 * price instead of this book's price.
 */
export const BRIEF_RULES: Record<ProductType, string> = {
  ecom: '',

  ebook: `THIS IS A DIGITAL EBOOK, and the source is usually the book itself
rather than a shop.

- "features" are what the reader will be able to DO after reading it: the
  chapters, the frameworks, the templates, the specific problems it solves.
  A page count is not a feature. A chapter title is only a feature if you say
  what it teaches.
- There is no shipping, no size, no variant and no stock. Never mention them.
- The price is very often NOT in the file. Leave it at 0 and put it in "gaps".
  Do not read a price off a sample invoice, a bonus offer or a footer.
- review_snippets will usually be empty. Praise printed inside the book —
  endorsements, forewords, "what readers say" pages — is NOT a customer review
  of the product and must not be copied into review_snippets. Leave it empty
  and say so in "gaps".
- top_objections for a digital product are the real ones: is this just free
  blog posts, will I actually read it, is it out of date, is it written for
  someone at my level. Take them from the source where it pre-empts them.`,

  vehicle: `THIS IS ONE SPECIFIC SECOND-HAND VEHICLE OR VESSEL, not a model line.

- Everything you write describes THIS unit. If the source says 2019 Ranger
  Wildtrak with 96,400 km, that is the product. Do not add what a 2019 Ranger
  Wildtrak generally has. A buyer who reads a feature that is not on this
  particular vehicle finds out at the inspection, and that is the single worst
  failure this brief can produce.
- "features" are its actual particulars: build year, odometer or engine hours,
  transmission, drivetrain, fuel, colour, trim, registration and its expiry,
  compliance, service history, hull and engine make for a vessel, trailer,
  survey, what is included in the sale.
- practical_benefit still applies: "full service history" lets the buyer skip a
  pre-purchase inspection argument.
- Condition and faults matter and are not negatives to be smoothed away. If the
  source names a scratch, a due service, or a repairable write-off history,
  record it. Put anything a buyer would want and the source does not say —
  odometer, rego expiry, written-off status, finance owing — into "gaps".
- There is no cart. price.offer_structure describes the terms the seller stated
  (negotiable, ono, trade-ins considered, finance available) or is empty.
- review_snippets is almost always empty. Never treat a review of the model
  line, a magazine test or a manufacturer claim as a customer review of this
  vehicle.`,
};

/** The same, for the page copywriter and the persona writer. */
export const COPY_RULES: Record<ProductType, string> = {
  ecom: '',

  ebook: `THIS PAGE SELLS A DIGITAL EBOOK.
- Reasons are what the reader will be able to do afterwards, not what is in the
  table of contents.
- Never promise an outcome the brief does not support, and never imply a
  qualification, a certification or an earnings result.
- Instant download and "read it tonight" are true and are worth saying. Delivery
  times, shipping and stock are not — do not mention them.`,

  vehicle: `THIS PAGE SELLS ONE SPECIFIC USED VEHICLE OR VESSEL. There is exactly
one of it.

- Every reason is about THIS unit and its stated particulars. Never a general
  virtue of the model, never a manufacturer claim, never a comparison to a rival
  you have no data on.
- Scarcity is real here and does not need inventing: there is one of these, and
  saying so plainly beats a countdown.
- Do not state a price anywhere except the offer fields, and only the price the
  brief actually gives.
- THE BUYER DOES NOT CHECK OUT. They ring, or they leave their number. Write
  every call to action as making contact — "Call about this one",
  "Book an inspection", "Ask about the service history" — never "Buy now",
  "Add to cart", "Order today" or anything that implies a purchase online.
- The offer block is the invitation to enquire, not a discount.`,
};

/** Appended to the persona writer, on top of COPY_RULES. */
export const PERSONA_RULES: Record<ProductType, string> = {
  ecom: '',

  ebook: `Personas for a book are readers at different starting points and with
different reasons for needing it — the beginner who is embarrassed to ask, the
practitioner who wants one specific chapter, the person who has bought three of
these and finished none. Their fear is usually about themselves, not the
product.`,

  vehicle: `There are only five personas for this vehicle and there is only one
vehicle, so make the five count. They are five genuinely different reasons a
person is shopping for this exact thing — the tradesman who needs it to earn on
Monday, the family sizing up, the first-car parent buying for a teenager, the
weekend user, the buyer replacing one they wrote off. Their fears are the used
market's real fears: hidden history, what it will cost to keep, being talked
into it, driving hours to see a lemon.

Every one of them ends by making contact, not by buying.`,
};
