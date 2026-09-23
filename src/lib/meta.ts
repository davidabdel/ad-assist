/**
 * Meta Marketing API — the only place in this app that can create something on
 * somebody else's platform.
 *
 * Three rules govern everything here.
 *
 * 1. NOTHING IS EVER CREATED ACTIVE. Every campaign, ad set and ad this module
 *    writes carries `status: 'PAUSED'`, and it is not a parameter. Turning an
 *    ad on is a decision with a spend attached, and the app has no way to know
 *    the operator is still at the keyboard when the last of forty creatives
 *    finishes uploading. Unpausing happens in Ads Manager, by a person.
 *
 * 2. EVERY WRITE CAN BE REHEARSED. Meta's `execute_only_if_valid` — sent as
 *    `validate_only` — runs the whole server-side validation of a payload and
 *    returns success without creating the object. So the review screen can tell
 *    the operator the ad set will be rejected for a missing pixel BEFORE the
 *    campaign above it exists, instead of half-building a structure and leaving
 *    the wreckage in their account.
 *
 * 3. A HALF-BUILT CAMPAIGN IS THE FAILURE MODE TO DESIGN FOR. Publishing forty
 *    ads is forty writes over several minutes, and Meta rate-limits. Every id
 *    this module returns is written to `publish_items` by the caller before the
 *    next call goes out, so a crash leaves a resumable run and never an orphan
 *    the operator has to hunt for in Ads Manager.
 */

/**
 * Pinned, not floating.
 *
 * Meta silently serves an unknown version string from the app's default
 * version rather than erroring — `v99.0` answers — so probing cannot tell you
 * what is current and a typo cannot be caught by testing. Pinning means a
 * breaking change in a future version arrives when we move this line, which is
 * the only way an unattended publish path stays predictable.
 */
export const GRAPH_VERSION = 'v23.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

export class MetaError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly subcode?: number,
    readonly userTitle?: string,
    readonly userMessage?: string,
    readonly fbtraceId?: string,
  ) {
    super(message);
    this.name = 'MetaError';
  }

  /**
   * What to put on the screen.
   *
   * Meta's `error.message` is written for a developer reading a stack trace —
   * "Invalid parameter" — while `error_user_title` and `error_user_msg` are the
   * strings Ads Manager itself shows a human, and they are usually the actual
   * reason. Prefer them, and keep the raw message as the tail so a support
   * conversation still has something to search on.
   */
  get display(): string {
    const human = [this.userTitle, this.userMessage].filter(Boolean).join(' — ');
    return human ? `${human} (${this.message})` : this.message;
  }
}

function token(): string {
  const t = process.env.META_ACCESS_TOKEN;
  if (!t) {
    throw new MetaError(
      'META_ACCESS_TOKEN is not set. The app cannot reach Meta until the system '
      + 'user token is in the environment.',
    );
  }
  return t;
}

type Params = Record<string, unknown>;

/**
 * One call to the Graph API.
 *
 * Everything goes through here so that the token is read in exactly one place
 * and never appears in a query string we log: it is sent as a form field on
 * POSTs, and on GETs it is the only reason this builds a URLSearchParams rather
 * than a template string.
 *
 * Objects and arrays are JSON-encoded, because Meta takes nested structures —
 * `targeting`, `object_story_spec` — as JSON inside a form field, not as
 * bracketed form keys.
 */
async function graph<T>(
  path: string,
  opts: { method?: 'GET' | 'POST' | 'DELETE'; params?: Params } = {},
): Promise<T> {
  const method = opts.method ?? 'GET';
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    if (v === undefined || v === null) continue;
    body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  body.set('access_token', token());

  const url = method === 'GET' ? `${GRAPH}/${path}?${body}` : `${GRAPH}/${path}`;
  const res = await fetch(url, {
    method,
    ...(method === 'GET' ? {} : { body }),
  });

  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MetaError(`Meta returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
  }

  const err = (json as { error?: Record<string, unknown> }).error;
  if (err) {
    throw new MetaError(
      String(err.message ?? 'Unknown Meta error'),
      err.code as number | undefined,
      err.error_subcode as number | undefined,
      err.error_user_title as string | undefined,
      err.error_user_msg as string | undefined,
      err.fbtrace_id as string | undefined,
    );
  }
  if (!res.ok) throw new MetaError(`Meta returned ${res.status}: ${text.slice(0, 300)}`);

  return json as T;
}

/** Walks `paging.next` so a business with more than one page of assets is not silently truncated. */
async function graphAll<T>(path: string, params: Params = {}): Promise<T[]> {
  const out: T[] = [];
  let page = await graph<{ data: T[]; paging?: { next?: string } }>(
    path,
    { params: { ...params, limit: 100 } },
  );
  out.push(...(page.data ?? []));
  let guard = 0;
  while (page.paging?.next && guard++ < 20) {
    const res = await fetch(page.paging.next);
    page = await res.json();
    out.push(...(page.data ?? []));
  }
  return out;
}

// ─── Screen 1: what the operator can choose from ──────────────────────────

export type AdAccount = {
  id: string;
  name: string;
  /** 1 is active. Anything else and Meta refuses every write on it. */
  account_status: number;
  currency: string;
  timezone_name: string;
  /**
   * Absent when no payment method is attached. This is the field that decides
   * whether an account can ever run an ad, so the wizard reads it rather than
   * discovering the problem at publish time.
   */
  funding_source_details?: { id: string; display_string?: string };
};

export function listAdAccounts(): Promise<AdAccount[]> {
  return graphAll<AdAccount>('me/adaccounts', {
    fields: 'id,name,account_status,currency,timezone_name,funding_source_details',
  });
}

export type AdPage = { id: string; name: string };

/**
 * The Pages this ad account may actually advertise as.
 *
 * Deliberately per-account, not a global page list. Meta will not accept a
 * creative whose `page_id` is a page the *ad account* has no link to, even when
 * the token's owner administers it — which is the single most common reason a
 * first publish fails. Asking the account itself means the dropdown can only
 * ever offer valid answers.
 */
export function listPromotePages(adAccountId: string): Promise<AdPage[]> {
  return graphAll<AdPage>(`${adAccountId}/promote_pages`, { fields: 'id,name' });
}

export type AdPixel = { id: string; name: string };

export function listPixels(adAccountId: string): Promise<AdPixel[]> {
  return graphAll<AdPixel>(`${adAccountId}/adspixels`, { fields: 'id,name' });
}

// ─── Creative uploads ─────────────────────────────────────────────────────

/**
 * Put an image in the ad account's library and get back the hash a creative
 * refers to.
 *
 * Meta does not fetch images from a URL for ad creatives — the bytes have to be
 * uploaded — so the caller hands over what it pulled from our own storage.
 * The response keys the result by the filename we sent, which is why the
 * filename is a parameter and not a constant: two different pictures uploaded
 * under one name in the same call would come back indistinguishable.
 */
export async function uploadAdImage(
  adAccountId: string,
  bytes: Uint8Array,
  filename: string,
): Promise<string> {
  const form = new FormData();
  form.set('access_token', token());
  form.set(filename, new Blob([bytes as BlobPart]), filename);

  const res = await fetch(`${GRAPH}/${adAccountId}/adimages`, { method: 'POST', body: form });
  const json = await res.json() as {
    images?: Record<string, { hash: string }>;
    error?: Record<string, unknown>;
  };
  if (json.error) {
    throw new MetaError(
      String(json.error.message),
      json.error.code as number,
      json.error.error_subcode as number,
      json.error.error_user_title as string,
      json.error.error_user_msg as string,
    );
  }
  const hash = json.images?.[filename]?.hash ?? Object.values(json.images ?? {})[0]?.hash;
  if (!hash) throw new MetaError(`Meta accepted the image but returned no hash: ${JSON.stringify(json).slice(0, 200)}`);
  return hash;
}

/**
 * Hand Meta a video by URL and get back an id that is not yet usable.
 *
 * Videos are the one asynchronous thing in a publish run: Meta accepts the
 * upload immediately and then transcodes, and a creative built against a video
 * still in `processing` is rejected. So this returns the id and the caller
 * waits on {@link videoReady} — which is also why a publish run is a job with
 * resumable state rather than one long request.
 */
export async function uploadAdVideo(
  adAccountId: string,
  fileUrl: string,
  name: string,
): Promise<string> {
  const r = await graph<{ id: string }>(`${adAccountId}/advideos`, {
    method: 'POST',
    params: { file_url: fileUrl, name },
  });
  return r.id;
}

export type VideoStatus = { ready: boolean; phase: string; error?: string };

export async function videoReady(videoId: string): Promise<VideoStatus> {
  const r = await graph<{ status?: { video_status?: string; processing_phase?: { status?: string } } }>(
    videoId,
    { params: { fields: 'status' } },
  );
  const phase = r.status?.video_status ?? r.status?.processing_phase?.status ?? 'unknown';
  return {
    ready: phase === 'ready',
    phase,
    error: phase === 'error' ? 'Meta could not process the video' : undefined,
  };
}

// ─── The four objects a live ad is made of ────────────────────────────────

/**
 * Our CTA wording to Meta's enum.
 *
 * `CTA_LABELS` is what a person reads on the ideas table; these are the only
 * strings the API accepts. Kept as an explicit map rather than an uppercase-
 * and-underscore transform because two of them do not transform: Meta's button
 * for "Book Now" is `BOOK_TRAVEL`, and "Get Offer" is `GET_OFFER` only on link
 * ads. A silent fallback would ship an ad with the wrong button on it, so an
 * unmapped label throws.
 */
const CTA_TO_META: Record<string, string> = {
  'Shop Now': 'SHOP_NOW',
  'Learn More': 'LEARN_MORE',
  'Get Offer': 'GET_OFFER',
  'Sign Up': 'SIGN_UP',
  'Subscribe': 'SUBSCRIBE',
  'Book Now': 'BOOK_TRAVEL',
  'Get Quote': 'GET_QUOTE',
  'Contact Us': 'CONTACT_US',
  'Call Now': 'CALL_NOW',
  'Download': 'DOWNLOAD',
  'Order Now': 'ORDER_NOW',
  'Apply Now': 'APPLY_NOW',
};

export function metaCta(label: string): string {
  const v = CTA_TO_META[label];
  if (!v) throw new MetaError(`"${label}" is not a button Meta offers. Pick one from the ad's CTA list.`);
  return v;
}

/** What the campaign is for. The wizard offers these three and nothing else. */
export type Objective = 'OUTCOME_TRAFFIC' | 'OUTCOME_LEADS' | 'OUTCOME_SALES';

export type CreateOpts = {
  /**
   * Run Meta's full validation and return without creating anything.
   *
   * The review screen sets this on every object in the run, in order, so the
   * operator sees all the errors at once rather than the first one.
   */
  validateOnly?: boolean;
};

function withValidate(params: Params, opts?: CreateOpts): Params {
  return opts?.validateOnly ? { ...params, execute_only_if_valid: false, validate_only: true } : params;
}

export async function createCampaign(
  adAccountId: string,
  args: {
    name: string;
    objective: Objective;
    /** Set only for campaign-budget optimisation. Minor units — cents, for an AUD account. */
    dailyBudgetMinor?: number;
    lifetimeBudgetMinor?: number;
  },
  opts?: CreateOpts,
): Promise<string> {
  const r = await graph<{ id: string }>(`${adAccountId}/campaigns`, {
    method: 'POST',
    params: withValidate({
      name: args.name,
      objective: args.objective,
      status: 'PAUSED',
      // Required on every campaign, and an empty list is a positive statement,
      // not a default: it declares the ads are not credit, employment, housing,
      // politics or social issues. Meta rejects the create if the field is
      // missing entirely.
      special_ad_categories: [],
      ...(args.dailyBudgetMinor ? { daily_budget: args.dailyBudgetMinor } : {}),
      ...(args.lifetimeBudgetMinor ? { lifetime_budget: args.lifetimeBudgetMinor } : {}),
      // Only meaningful — and only accepted — when the budget lives on the ad
      // sets. Meta REFUSES a campaign that has no campaign budget and does not
      // say which way this goes (subcode 4834011), so it cannot be left out.
      //
      // False on purpose. True lets Meta move a fifth of one ad set's budget to
      // another that is performing better, and every ad set in this app is one
      // persona: shifting spend between them is Meta deciding which buyer to
      // test, which is the one thing the operator is running the campaign to
      // find out for themselves.
      ...(args.dailyBudgetMinor || args.lifetimeBudgetMinor
        ? {}
        : { is_adset_budget_sharing_enabled: false }),
    }, opts),
  });
  return r.id;
}

export type Targeting = {
  geo_locations: {
    countries?: string[];
    cities?: { key: string; radius?: number; distance_unit?: 'kilometer' | 'mile' }[];
  };
  age_min?: number;
  age_max?: number;
  /** Meta's encoding: 1 male, 2 female. Omit the field entirely for everyone. */
  genders?: number[];
  flexible_spec?: { interests?: { id: string; name?: string }[] }[];
};

export async function createAdSet(
  adAccountId: string,
  args: {
    name: string;
    campaignId: string;
    /** Omitted when the campaign holds the budget. Meta rejects a budget in both places. */
    dailyBudgetMinor?: number;
    lifetimeBudgetMinor?: number;
    billingEvent: 'IMPRESSIONS' | 'LINK_CLICKS';
    optimizationGoal:
      | 'LINK_CLICKS' | 'LANDING_PAGE_VIEWS' | 'OFFSITE_CONVERSIONS'
      | 'LEAD_GENERATION' | 'REACH';
    targeting: Targeting;
    /** ISO 8601. Meta reads it in the ad account's own timezone if no offset is given, so always send one. */
    startTime: string;
    endTime?: string;
    /** Required for conversion optimisation: which pixel, and which event counts as success. */
    promotedObject?: { pixel_id?: string; custom_event_type?: string; page_id?: string };
  },
  opts?: CreateOpts,
): Promise<string> {
  const r = await graph<{ id: string }>(`${adAccountId}/adsets`, {
    method: 'POST',
    params: withValidate({
      name: args.name,
      campaign_id: args.campaignId,
      status: 'PAUSED',
      billing_event: args.billingEvent,
      optimization_goal: args.optimizationGoal,
      targeting: args.targeting,
      start_time: args.startTime,
      ...(args.endTime ? { end_time: args.endTime } : {}),
      ...(args.dailyBudgetMinor ? { daily_budget: args.dailyBudgetMinor } : {}),
      ...(args.lifetimeBudgetMinor ? { lifetime_budget: args.lifetimeBudgetMinor } : {}),
      ...(args.promotedObject ? { promoted_object: args.promotedObject } : {}),
    }, opts),
  });
  return r.id;
}

/**
 * Opting out of Meta rewriting the ad.
 *
 * Left alone, Advantage+ creative enhancements will crop the image, add music,
 * change the wording of the primary text and overlay text of its own. For this
 * app that is not an enhancement — the whole product is a specific picture and
 * a specific sentence written for one persona, and the operator approved that
 * exact row. So every creative opts out, and it is not a setting.
 */
const NO_AUTO_ENHANCEMENTS = {
  creative_features_spec: { standard_enhancements: { enroll_status: 'OPT_OUT' } },
};

export async function createImageCreative(
  adAccountId: string,
  args: {
    name: string;
    pageId: string;
    imageHash: string;
    /** The ad's body copy. */
    message: string;
    headline: string;
    description?: string;
    link: string;
    ctaLabel: string;
  },
  opts?: CreateOpts,
): Promise<string> {
  const r = await graph<{ id: string }>(`${adAccountId}/adcreatives`, {
    method: 'POST',
    params: withValidate({
      name: args.name,
      object_story_spec: {
        page_id: args.pageId,
        link_data: {
          image_hash: args.imageHash,
          link: args.link,
          message: args.message,
          name: args.headline,
          ...(args.description ? { description: args.description } : {}),
          call_to_action: { type: metaCta(args.ctaLabel), value: { link: args.link } },
        },
      },
      degrees_of_freedom_spec: NO_AUTO_ENHANCEMENTS,
    }, opts),
  });
  return r.id;
}

export async function createVideoCreative(
  adAccountId: string,
  args: {
    name: string;
    pageId: string;
    videoId: string;
    /**
     * A still for the video, as a hash already in the ad account's library.
     *
     * Not optional and not a nicety: Meta rejects a video creative with no
     * thumbnail. The caller pulls a frame and uploads it through
     * {@link uploadAdImage} like any other picture.
     */
    thumbnailHash: string;
    message: string;
    headline: string;
    description?: string;
    link: string;
    ctaLabel: string;
  },
  opts?: CreateOpts,
): Promise<string> {
  const r = await graph<{ id: string }>(`${adAccountId}/adcreatives`, {
    method: 'POST',
    params: withValidate({
      name: args.name,
      object_story_spec: {
        page_id: args.pageId,
        video_data: {
          video_id: args.videoId,
          image_hash: args.thumbnailHash,
          message: args.message,
          title: args.headline,
          ...(args.description ? { link_description: args.description } : {}),
          call_to_action: { type: metaCta(args.ctaLabel), value: { link: args.link } },
        },
      },
      degrees_of_freedom_spec: NO_AUTO_ENHANCEMENTS,
    }, opts),
  });
  return r.id;
}

export async function createAd(
  adAccountId: string,
  args: { name: string; adsetId: string; creativeId: string },
  opts?: CreateOpts,
): Promise<string> {
  const r = await graph<{ id: string }>(`${adAccountId}/ads`, {
    method: 'POST',
    params: withValidate({
      name: args.name,
      adset_id: args.adsetId,
      creative: { creative_id: args.creativeId },
      status: 'PAUSED',
    }, opts),
  });
  return r.id;
}

// ─── Reading back ─────────────────────────────────────────────────────────

/**
 * What Meta thinks of the ads we made.
 *
 * `effective_status` is the field that answers "why is this not running" —
 * PAUSED because we made it so, DISAPPROVED because review rejected it,
 * CAMPAIGN_PAUSED because the parent is off. Without it the campaign screen can
 * only say what we wrote, which is not the same as what is true a day later.
 */
export type AdStatus = {
  id: string;
  name: string;
  effective_status: string;
  issues_info?: { error_message?: string; error_summary?: string }[];
};

export function readAdStatuses(campaignId: string): Promise<AdStatus[]> {
  return graphAll<AdStatus>(`${campaignId}/ads`, {
    fields: 'id,name,effective_status,issues_info',
  });
}

/** Search Meta's city index so the audience screen can offer real place keys. */
export type GeoCity = { key: string; name: string; region?: string; country_code: string };

export function searchCities(query: string, countries?: string[]): Promise<GeoCity[]> {
  return graphAll<GeoCity>('search', {
    type: 'adgeolocation',
    location_types: ['city'],
    q: query,
    ...(countries ? { country_code: countries[0] } : {}),
  });
}
