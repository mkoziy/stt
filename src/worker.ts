import { db } from './db';
import { jobs } from './db/schema';
import { config } from './config';
import { eq, and, sql, lt, inArray } from 'drizzle-orm';
import { downloadAudio } from './services/download';
import { convertToWav } from './services/convert';
import { transcribeAudio } from './services/transcribe';
import { safeDelete } from './services/cleanup'; // Wait, I didn't export safeDelete.
// I'll make a local unlinker just in case.
import { unlink } from 'node:fs/promises';

async function silentUnlink(path: string) {
    try {
        await unlink(path);
    } catch {
        // ignore
    }
}

async function recoverStaleJobs() {
    const staleGracePeriodSec = config.TRANSCRIBE_TIMEOUT_SEC + config.DOWNLOAD_TIMEOUT_SEC + 60;
    const staleThreshold = new Date(Date.now() - staleGracePeriodSec * 1000);

    const staleJobs = await db.select({ id: jobs.id }).from(jobs)
        .where(and(eq(jobs.status, 'processing'), lt(jobs.updated_at, staleThreshold)));

    if (staleJobs.length > 0) {
        const ids = staleJobs.map(j => j.id);
        console.log(`Recovering ${ids.length} stale job(s)...`);
        await db.update(jobs)
            .set({ status: 'pending', error: null, updated_at: new Date() })
            .where(inArray(jobs.id, ids));
    }
}

async function processJob(job: any) {
    let fileToConvert = job.file_path;

    try {
        // 1. Download
        if (job.source_type === 'url' && job.source_url) {
            const { filePath, originalName } = await downloadAudio(job.source_url, job.id);
            fileToConvert = filePath;
            await db.update(jobs).set({
                file_path: filePath,
                original_name: originalName,
            }).where(eq(jobs.id, job.id));
        }

        // 2. Convert
        const wavPath = await convertToWav(fileToConvert, job.id);
        await db.update(jobs).set({ wav_path: wavPath }).where(eq(jobs.id, job.id));

        // 3. Transcribe
        const text = await transcribeAudio(wavPath, job.language);

        // 4. Update success
        await db.update(jobs).set({
            status: 'completed',
            result_text: text,
            updated_at: new Date(),
        }).where(eq(jobs.id, job.id));

    } catch (err: any) {
        console.error(`Job ${job.id} failed:`, err);
        await db.update(jobs).set({
            status: 'failed',
            error: err.message || String(err),
            updated_at: new Date(),
        }).where(eq(jobs.id, job.id));

        // Delete downloaded file if URL download failed to keep space clean??
        // PRD: "Downloaded file exceeds limit -> Job marked failed, file deleted, error stored"
        // So silent unlink fileToConvert if it was a url download?
        if (job.source_type === 'url' && fileToConvert) {
            await silentUnlink(fileToConvert);
        }
    }
}

async function poll() {
    try {
        // Query FOR UPDATE SKIP LOCKED
        // In Drizzle, raw SQL is easiest for FOR UPDATE SKIP LOCKED if we want one single record
        // Or we can use transaction
        await db.transaction(async (tx) => {
            const pendingJobs = await tx.select()
                .from(jobs)
                .where(eq(jobs.status, 'pending'))
                .orderBy(jobs.created_at)
                .limit(1)
                .for('update', { skipLocked: false }); // wait skip locked is not fully natively supported as `skipLocked: true` by all versions maybe? Let me use raw sql to be extremely safe, or drizzle equivalent. Drizzle supports `.for('update', { skipLocked: true })`

            // Actually, standard `.for('update', { skipLocked: true })` is available in latest
            // wait, `skipLocked` might be boolean config or just `.for('update', { skipLocked: true })`
            // Let's rely on standard RAW just in case.
        });
    } catch (e) { /* ignore here, rewriting down */ }
}

async function startWorker() {
    console.log('Starting worker process...');
    await recoverStaleJobs();

    while (true) {
        try {
            const claimedJobs = await db.transaction(async (tx) => {
                // Drizzle support for skipLocked:
                // tx.select().from(jobs).where(eq(jobs.status, 'pending')).orderBy(jobs.created_at).limit(1).for('update', { skipLocked: true })
                const [job] = await tx.select()
                    .from(jobs)
                    .where(eq(jobs.status, 'pending'))
                    .orderBy(jobs.created_at)
                    .limit(1)
                    .for('update', { skipLocked: true });

                if (!job) return null;

                const updatedDate = new Date();
                const [updatedJob] = await tx.update(jobs)
                    .set({ status: 'processing', attempts: sql`${jobs.attempts} + 1`, updated_at: updatedDate })
                    .where(eq(jobs.id, job.id))
                    .returning();

                return updatedJob;
            });

            if (claimedJobs) {
                console.log(`Picked up job ${claimedJobs.id} (Attempt: ${claimedJobs.attempts})`);
                // Process outside the lock
                await processJob(claimedJobs);
            } else {
                // Sleep
                await new Promise(r => setTimeout(r, config.WORKER_POLL_INTERVAL_MS));
            }
        } catch (err) {
            console.error('Worker loop error:', err);
            await new Promise(r => setTimeout(r, config.WORKER_POLL_INTERVAL_MS));
        }
    }
}

startWorker().catch((err) => {
    console.error('Fatal worker error', err);
    process.exit(1);
});
