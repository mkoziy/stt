import { Hono } from 'hono';
import { db } from '../db';
import { jobs } from '../db/schema';
import { eq, and, lt } from 'drizzle-orm';
import { config } from '../config';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

const jobsApp = new Hono();

async function ensureDir(dir: string) {
    try {
        await mkdir(dir, { recursive: true });
    } catch (err: any) {
        if (err.code !== 'EEXIST') throw err;
    }
}

const SUPPORTED_FORMATS = ['.mp3', '.ogg', '.wav', '.m4a', '.webm'];

jobsApp.post('/', async (c) => {
    const contentType = c.req.header('content-type') || '';
    let sourceType: 'upload' | 'url' = 'upload';
    let sourceUrl: string | null = null;
    let language: string | null = null;
    let originalName: string | null = null;
    let uploadFile: File | null = null;

    if (contentType.includes('multipart/form-data')) {
        const body = await c.req.parseBody();
        uploadFile = body['file'] as Exclude<typeof body['file'], string> | null;
        language = body['language'] as string || null;

        if (!uploadFile) {
            return c.json({ error: 'No file provided' }, 400);
        }

        originalName = uploadFile.name || 'upload';
        const ext = originalName.substring(originalName.lastIndexOf('.')).toLowerCase();
        if (!SUPPORTED_FORMATS.includes(ext)) {
            return c.json({ error: `Unsupported audio format. Allowed: ${SUPPORTED_FORMATS.join(', ')}` }, 400);
        }

        const maxBytes = config.MAX_FILE_SIZE_MB * 1024 * 1024;
        if (uploadFile.size > maxBytes) {
            return c.json({ error: `File exceeds maximum size of ${config.MAX_FILE_SIZE_MB}MB` }, 413);
        }
    } else if (contentType.includes('application/json')) {
        sourceType = 'url';
        const body = await c.req.json().catch(() => ({}));
        sourceUrl = body.url as string;
        language = body.language as string || null;

        if (!sourceUrl) {
            return c.json({ error: 'No url provided' }, 400);
        }
        if (!sourceUrl.startsWith('http://') && !sourceUrl.startsWith('https://')) {
            return c.json({ error: 'Invalid URL format' }, 400);
        }
        originalName = sourceUrl.split('/').pop() || 'url_download';
    } else {
        return c.json({ error: 'Unsupported Content-Type. Use multipart/form-data or application/json' }, 400);
    }

    // Insert to get ID first
    const [job] = await db.insert(jobs).values({
        source_type: sourceType,
        source_url: sourceUrl,
        language: language,
        original_name: originalName,
        file_path: '', // will update
        max_attempts: config.MAX_ATTEMPTS,
    }).returning({ id: jobs.id, status: jobs.status });

    const jobId = job.id;
    let finalFilePath = '';

    if (sourceType === 'upload' && uploadFile) {
        await ensureDir(config.STORAGE_DIR);
        const ext = originalName ? originalName.substring(originalName.lastIndexOf('.')).toLowerCase() : '';
        finalFilePath = join(config.STORAGE_DIR, `${jobId}${ext}`);
        const bytes = await uploadFile.arrayBuffer();
        await Bun.write(finalFilePath, bytes);

        await db.update(jobs).set({ file_path: finalFilePath }).where(eq(jobs.id, jobId));
    } else {
        // For URL, the worker handles download and sets it, but we can set a dummy or temp relative path for now
        await db.update(jobs).set({ file_path: '' }).where(eq(jobs.id, jobId));
    }

    return c.json({ id: jobId, status: job.status }, 201);
});

jobsApp.get('/:id', async (c) => {
    const id = c.req.param('id');
    const [job] = await db.select().from(jobs).where(eq(jobs.id, id));

    if (!job) {
        return c.json({ error: 'Job not found' }, 404);
    }

    return c.json(job);
});

jobsApp.post('/:id/retry', async (c) => {
    const id = c.req.param('id');
    const [job] = await db.select().from(jobs).where(eq(jobs.id, id));

    if (!job) {
        return c.json({ error: 'Job not found' }, 404);
    }

    if (job.status !== 'failed') {
        return c.json({ error: 'Job is not in a failed state' }, 409);
    }

    if (job.attempts >= job.max_attempts) {
        return c.json({ error: 'Job has reached maximum retry attempts' }, 409);
    }

    const [updated] = await db.update(jobs)
        .set({ status: 'pending', error: null, updated_at: new Date() })
        .where(eq(jobs.id, id))
        .returning({ id: jobs.id, status: jobs.status });

    return c.json({ id: updated.id, status: updated.status });
});

export default jobsApp;
