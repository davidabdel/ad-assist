import { z } from 'zod';
import { AuthError, requireOwner } from '@/lib/auth';
import { serviceClient } from '@/lib/supabase';
import { BUCKET, MAX_BYTES, UPLOAD_KINDS, publicUrlFor, storagePath, type UploadKind } from '@/lib/uploads';

export const dynamic = 'force-dynamic';

/**
 * THE FILE DOES NOT COME THROUGH THIS ROUTE. It hands back a one-shot signed
 * upload URL and the browser puts the bytes straight into Supabase Storage.
 *
 * That is not an optimisation, it is the only thing that works: a Vercel
 * serverless function refuses a request body over 4.5 MB, and an ebook PDF is
 * routinely bigger than that. Proxying the file would have failed on exactly the
 * files this feature exists for, and it would have failed as an opaque 413.
 *
 * What is still enforced here, before any token is issued: that the caller is
 * the owner, that the kind of file matches what that slot accepts, and that the
 * size is sane. The token is scoped to one path and expires, so it cannot be
 * reused to fill the bucket.
 */

const RequestSchema = z.object({
  kind: z.enum(UPLOAD_KINDS),
  filename: z.string().min(1).max(200),
  content_type: z.string().min(3).max(120),
  size: z.number().int().positive(),
});

const ACCEPTS: Record<UploadKind, RegExp> = {
  pdf: /^application\/pdf$/,
  image: /^image\/(png|jpeg|webp)$/,
};

const HUMAN: Record<UploadKind, string> = {
  pdf: 'a PDF',
  image: 'a PNG, JPEG or WebP picture',
};

export async function POST(req: Request) {
  try {
    const owner = await requireOwner(req);
    const parsed = RequestSchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json({ error: z.treeifyError(parsed.error) }, { status: 400 });
    }
    const { kind, filename, content_type: type, size } = parsed.data;

    if (!ACCEPTS[kind].test(type.split(';')[0].trim())) {
      return Response.json(
        { error: `That slot takes ${HUMAN[kind]}. "${filename}" is ${type}.` },
        { status: 400 },
      );
    }
    if (size > MAX_BYTES[kind]) {
      const mb = Math.round(MAX_BYTES[kind] / (1024 * 1024));
      return Response.json(
        { error: `"${filename}" is ${(size / (1024 * 1024)).toFixed(1)} MB. The limit is ${mb} MB.` },
        { status: 400 },
      );
    }

    const path = storagePath(owner.id, filename);
    const { data, error } = await serviceClient()
      .storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) return Response.json({ error: error.message }, { status: 500 });

    return Response.json({
      bucket: BUCKET,
      path: data.path,
      token: data.token,
      // Handed back rather than rebuilt in the browser, so the one place that
      // knows how a public storage URL is spelled stays on the server.
      public_url: publicUrlFor(data.path),
    });
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
