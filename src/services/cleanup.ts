import { db } from '../db';
import { jobs } from '../db/schema';
import { lt, inArray } from 'drizzle-orm';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config';

async function safeDelete(filePath: string) {
    try {
        await unlink(filePath);
    } catch (err: any) {
        if (err.code !== 'ENOENT') {
            console.warn(`Failed to delete file ${filePath}:`, err);
        }
    }
}

export async function runCleanup() {
    const retentionMs = config.CLEANUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const cutoffDate = new Date(Date.now() - retentionMs);

    console.log(`Starting cleanup... Looking for jobs older than ${cutoffDate.toISOString()}`);

    // Fetch old jobs
    const oldJobs = await db.select().from(jobs).where(lt(jobs.created_at, cutoffDate));

    if (oldJobs.length > 0) {
        const jobIds = oldJobs.map(j => j.id);
        console.log(`Found ${jobIds.length} jobs to delete.`);

        // Delete files
        for (const job of oldJobs) {
            if (job.file_path) await safeDelete(job.file_path);
            if (job.wav_path) await safeDelete(job.wav_path);
        }

        // Delete DB records
        await db.delete(jobs).where(inArray(jobs.id, jobIds));
        console.log(`Deleted ${jobIds.length} DB records.`);
    } else {
        console.log('No jobs found to clean up.');
    }

    // Find orphaned files (files in STORAGE_DIR that don't match any DB record)
    try {
        const files = await readdir(config.STORAGE_DIR);
        const validJobIds = new Set((await db.select({ id: jobs.id }).from(jobs)).map(j => j.id));

        let orphans = 0;
        for (const file of files) {
            // Typically files are named like UUID.ext or UUID.wav.txt etc
            const uuidMatch = file.match(/^([a-f0-9\-]{36})/);
            if (uuidMatch) {
                const fileJobId = uuidMatch[1];
                if (fileJobId && !validJobIds.has(fileJobId)) {
                    await safeDelete(join(config.STORAGE_DIR, file));
                    orphans++;
                }
            }
        }
        if (orphans > 0) {
            console.log(`Deleted ${orphans} orphaned audio files.`);
        }
    } catch (err) {
        console.error('Error cleaning up orphans:', err);
    }

    console.log('Cleanup finished.');
}
