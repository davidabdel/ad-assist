'use client';

import { browserClient } from './browser-supabase';
import { BUCKET, type UploadKind } from './uploads';

/**
 * Two steps, because the file never touches our own server.
 *
 *   1. ask the API for a one-shot signed upload token (it checks who we are,
 *      what kind of file this slot takes, and how big it is);
 *   2. put the bytes straight into Supabase Storage with that token.
 *
 * See the note in `app/api/uploads/route.ts` for why: a Vercel function refuses
 * a body over 4.5 MB and an ebook is routinely larger.
 */

type Ticket = { path: string; token: string; public_url: string };

export type UploadedFile = { url: string; name: string };

export async function uploadFile(
  api: <T>(path: string, init?: RequestInit) => Promise<T>,
  kind: UploadKind,
  file: File,
): Promise<UploadedFile> {
  const ticket = await api<Ticket>('/api/uploads', {
    method: 'POST',
    body: JSON.stringify({
      kind,
      filename: file.name,
      // Some browsers hand back an empty type for a drag-dropped PDF. Naming it
      // from the extension is better than a 400 the operator cannot act on.
      content_type: file.type || (kind === 'pdf' ? 'application/pdf' : 'image/jpeg'),
      size: file.size,
    }),
  });

  const { error } = await browserClient()
    .storage.from(BUCKET)
    .uploadToSignedUrl(ticket.path, ticket.token, file, {
      contentType: file.type || undefined,
    });
  if (error) throw new Error(`"${file.name}" did not upload: ${error.message}`);

  return { url: ticket.public_url, name: file.name };
}
