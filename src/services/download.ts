import { mkdir, unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { config } from '../config';

async function ensureDir(dir: string) {
    try {
        await mkdir(dir, { recursive: true });
    } catch (err: any) {
        if (err.code !== 'EEXIST') throw err;
    }
}

export async function downloadAudio(url: string, jobId: string): Promise<{ filePath: string, originalName: string }> {
    await ensureDir(config.STORAGE_DIR);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.DOWNLOAD_TIMEOUT_SEC * 1000);

    try {
        const response = await fetch(url, { signal: controller.signal });

        if (!response.ok) {
            throw new Error(`Failed to download audio: ${response.status} ${response.statusText}`);
        }

        // Try to get original name from url
        const parsedUrl = new URL(url);
        const originalName = parsedUrl.pathname.split('/').pop() || 'audio_download';

        // Ext logic
        let ext = extname(originalName);
        if (!ext) {
            const contentType = response.headers.get('content-type');
            if (contentType?.includes('audio/ogg')) ext = '.ogg';
            else if (contentType?.includes('audio/mpeg')) ext = '.mp3';
            else if (contentType?.includes('audio/wav')) ext = '.wav';
            else if (contentType?.includes('audio/mp4')) ext = '.m4a';
            else if (contentType?.includes('audio/webm')) ext = '.webm';
            else ext = '.ogg'; // Fallback for things like telegram voice
        }

        const filePath = join(config.STORAGE_DIR, `${jobId}${ext}`);
        const fileFile = Bun.file(filePath);
        const maxBytes = config.MAX_FILE_SIZE_MB * 1024 * 1024;

        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > maxBytes) {
            throw new Error(`Downloaded file exceeds maximum size of ${config.MAX_FILE_SIZE_MB}MB`);
        }

        await Bun.write(filePath, arrayBuffer);
        return { filePath, originalName };
    } catch (err: any) {
        if (err.name === 'AbortError') {
            throw new Error(`Download timed out after ${config.DOWNLOAD_TIMEOUT_SEC} seconds`);
        }
        throw err;
    } finally {
        clearTimeout(timeoutId);
    }
}
