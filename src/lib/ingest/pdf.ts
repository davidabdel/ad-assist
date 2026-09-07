import { extractText, getDocumentProxy } from 'unpdf';

/**
 * Reading an ebook, which is the one product this app sells that has no page to
 * scrape. The source IS the file.
 *
 * `unpdf` rather than pdf-parse or pdfjs-dist directly, for the reason already
 * paid for once here: Next keeps some packages on `serverExternalPackages`, so
 * the serverless function `require()`s them, and a package whose dependency
 * chain is ESM-only then dies with ERR_REQUIRE_ESM and an empty 500 body —
 * invisible in a local build. unpdf is a self-contained serverless build of
 * pdfjs with no native bindings and no worker file to locate, so it gets
 * bundled like any other dependency. Same reasoning that put linkedom in
 * `cloud.ts` instead of jsdom.
 *
 * WHAT THIS DOES NOT DO: images. Rendering a PDF page to a picture needs a
 * canvas implementation, which is a native dependency and not available in a
 * serverless function. So an ebook campaign takes its pictures from the
 * operator's own uploads, and says so on the wizard rather than shipping blank
 * pages.
 */

/**
 * Enough to characterise a book without paying to reason over all of it. A
 * brief needs what the book teaches and who it is for; those are established in
 * the front matter, the contents and the first chapters, and the model is told
 * plainly that it is looking at an extract.
 */
const MAX_CHARS = 120_000;

/** Beyond this a "book" is a scanned archive and the text will be noise anyway. */
const MAX_PAGES = 400;

export type PdfRead = {
  payload: Record<string, unknown> | null;
  usable: boolean;
  reason?: string;
};

export async function ingestPdfFromUrl(url: string): Promise<PdfRead> {
  let bytes: Uint8Array;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return { payload: null, usable: false, reason: `the file returned HTTP ${res.status}` };
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return { payload: null, usable: false, reason: `the file could not be downloaded: ${(e as Error).message}` };
  }

  if (!bytes.length) return { payload: null, usable: false, reason: 'the uploaded file is empty' };
  // Anything else is not a PDF whatever the extension says, and pdfjs's own
  // failure for that case is an unreadable stack rather than a sentence.
  if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') {
    return { payload: null, usable: false, reason: 'that file is not a PDF' };
  }

  let pages: string[];
  let total: number;
  let meta: { Title?: string; Author?: string; Subject?: string; Keywords?: string } = {};
  try {
    const pdf = await getDocumentProxy(bytes);
    total = pdf.numPages;
    try {
      const info = await pdf.getMetadata();
      meta = (info?.info ?? {}) as typeof meta;
    } catch {
      // Metadata is a nicety. A book with none still has its text.
    }
    const extracted = await extractText(pdf, { mergePages: false });
    pages = (extracted.text as string[]).slice(0, MAX_PAGES);
  } catch (e) {
    return {
      payload: null,
      usable: false,
      reason: `the PDF could not be read: ${(e as Error).message}. `
        + 'A password-protected or scanned-image book has no text to extract.',
    };
  }

  const joined = pages.join('\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // A scanned book extracts as a handful of stray ligatures. Saying that is
  // worth far more than a brief built from four hundred pages of nothing.
  if (joined.length < 400) {
    return {
      payload: null,
      usable: false,
      reason: `only ${joined.length} characters of text came out of ${total} pages. `
        + 'This is almost certainly a scanned book — the pages are pictures, not text. '
        + 'Point the campaign at its sales page instead.',
    };
  }

  const truncated = joined.length > MAX_CHARS;
  const warnings: string[] = [];
  if (truncated) {
    warnings.push(`the book is ${total} pages; the first ${MAX_CHARS.toLocaleString()} `
      + 'characters were read, which covers the front matter, the contents and the '
      + 'opening chapters');
  }
  if (total > MAX_PAGES) warnings.push(`only the first ${MAX_PAGES} pages were opened`);
  warnings.push('this is the ebook itself, not a sales page: there is no price and there '
    + 'are no customer reviews in it, and neither may be invented');

  return {
    usable: true,
    payload: {
      source: 'pdf',
      source_url: url,
      page_title: meta.Title?.trim() || '',
      pdf_author: meta.Author?.trim() || '',
      pdf_subject: meta.Subject?.trim() || '',
      pdf_keywords: meta.Keywords?.trim() || '',
      page_count: total,
      markdown: truncated ? `${joined.slice(0, MAX_CHARS)}\n\n[...truncated]` : joined,
      reviews: [],
      images: [],
      structured: null,
      structured_source: null,
      warnings,
    },
  };
}
