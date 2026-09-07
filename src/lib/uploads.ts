/**
 * The operator's own files: the ebook PDF, and photographs of a vehicle.
 *
 * Shared by the API route that issues the upload token and the browser that
 * uses it, so the two never disagree about what is allowed or where a file
 * lands. Nothing here reads an environment variable that is server-only, which
 * is what makes it importable from a client component.
 */

export const BUCKET = 'campaign-uploads';

export const UPLOAD_KINDS = ['pdf', 'image'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

/**
 * Generous, because the limit exists to stop a mistake rather than to ration
 * storage. A 60 MB "ebook" is a scanned book and would be mostly unreadable
 * text anyway; a 12 MB "photo" is a raw export nobody meant to attach.
 */
export const MAX_BYTES: Record<UploadKind, number> = {
  pdf: 50 * 1024 * 1024,
  image: 10 * 1024 * 1024,
};

export const ACCEPT_ATTR: Record<UploadKind, string> = {
  pdf: 'application/pdf',
  image: 'image/png,image/jpeg,image/webp',
};

/**
 * Scoped by owner and always uniquified. Two campaigns both given `cover.jpg`
 * must not become one file, and a stored path must never be guessable from a
 * campaign anyone can see.
 */
export function storagePath(userId: string, filename: string): string {
  const safe = filename
    .replace(/[^\w.\-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(-80) || 'file';
  return `${userId}/${crypto.randomUUID()}-${safe}`;
}

export function publicUrlFor(path: string): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set');
  return `${base.replace(/\/$/, '')}/storage/v1/object/public/${BUCKET}/${path}`;
}
