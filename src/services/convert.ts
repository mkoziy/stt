import { join } from 'node:path';
import { config } from '../config';

export async function convertToWav(inputFile: string, jobId: string): Promise<string> {
    const wavPath = join(config.STORAGE_DIR, `${jobId}.wav`);

    const proc = Bun.spawn(
        ['ffmpeg', '-y', '-i', inputFile, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath],
        {
            stdout: 'ignore', // ffmpeg logs to stderr
            stderr: 'pipe',
        }
    );

    let stderr = '';
    // Timeout: converting shouldn't take forever, let's say max DOWNLOAD_TIMEOUT_SEC for conversion too
    const timeoutId = setTimeout(() => proc.kill(), config.DOWNLOAD_TIMEOUT_SEC * 1000);

    if (proc.stderr) {
        const reader = proc.stderr.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) {
                    stderr += new TextDecoder().decode(value);
                }
            }
        } finally {
            reader.releaseLock();
        }
    }

    const exitCode = await proc.exited;
    clearTimeout(timeoutId);

    if (exitCode !== 0) {
        throw new Error(`ffmpeg conversion failed (code ${exitCode}):\n${stderr}`);
    }

    return wavPath;
}
