/**
 * WE FETCH PICTURES OURSELVES RATHER THAN HANDING THE MODEL A URL.
 *
 * The first live image run failed on exactly that: the model was given the
 * seller's own image URLs and came back `400 Unable to download content from
 * the provided URL before the timeout`. Those URLs were fine — curl pulls them
 * in 40ms — but they are behind a CDN that refuses some clients (python-urllib
 * gets a bare 403) and they carry a second unencoded `https://` inside the
 * path, which is enough to defeat a fetcher that normalises URLs.
 *
 * Neither of those is fixable from here, and both will recur: every campaign
 * points at somebody else's CDN. Reading the bytes on our own server and
 * sending them inline removes the third party from the loop entirely, and it is
 * the same fetch, with the same browser headers, that already reads the product
 * page.
 *
 * Shared by the image stage (product photographs) and the brand stage (the
 * logo and the favicon), because the failure mode is identical for both.
 */

/**
 * Well above a product photo and well below anything that would make the
 * request unwieldy. A URL that serves more than this is not a product photo.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const IMAGE_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  'Accept-Language': 'en-AU,en;q=0.9',
  'Sec-Fetch-Dest': 'image',
  'Sec-Fetch-Mode': 'no-cors',
  'Sec-Fetch-Site': 'cross-site',
};

/** Magic bytes, for the CDNs that mislabel what they serve. */
function sniff(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * The picture as a data URL the model can be shown inline, or null when the
 * bytes could not be read or are not one of the four formats the API takes.
 *
 * SVG deliberately returns null. Half the logos on the web are SVG, the API
 * will not accept one, and rasterising it would mean a rendering dependency in
 * a serverless function. A brand whose logo is only available as SVG loses the
 * "look at the logo" evidence and keeps everything else.
 */
export async function asDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: IMAGE_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;

    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;

    // The four the API accepts. A CDN that returns `application/octet-stream`
    // for a webp is common enough to be worth the sniff rather than a rejection.
    const mime = /^image\/(png|jpeg|webp|gif)$/.test(type) ? type : sniff(buf);
    return mime ? `data:${mime};base64,${buf.toString('base64')}` : null;
  } catch {
    return null;
  }
}
