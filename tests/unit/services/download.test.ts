import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { downloadAudio } from '../../../src/services/download';
import { config } from '../../../src/config';

// Mock fs/promises
mock.module('node:fs/promises', () => {
    return {
        mkdir: mock(async () => { }),
        unlink: mock(async () => { }),
    };
});

describe('download service', () => {
    let originalFetch: typeof global.fetch;
    let originalBunWrite: typeof Bun.write;

    beforeEach(() => {
        originalFetch = global.fetch;
        originalBunWrite = Bun.write;

        // Default happy path mock for Bun.write
        Bun.write = mock(async () => 100) as any;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        Bun.write = originalBunWrite;
    });

    it('downloads audio successfully', async () => {
        global.fetch = mock(async () => {
            return new Response(new ArrayBuffer(10), {
                status: 200,
                headers: new Headers({ 'content-type': 'audio/mpeg' })
            });
        }) as any;

        const result = await downloadAudio('https://example.com/test.mp3', 'job-123');

        expect(result.filePath).toContain('job-123.mp3');
        expect(result.originalName).toBe('test.mp3');
        expect(global.fetch).toHaveBeenCalled();
        expect(Bun.write).toHaveBeenCalled();
    });

    it('falls back to extension from content-type if url has no extension', async () => {
        global.fetch = mock(async () => {
            return new Response(new ArrayBuffer(10), {
                status: 200,
                headers: new Headers({ 'content-type': 'audio/ogg' })
            });
        }) as any;

        const result = await downloadAudio('https://example.com/stream', 'job-456');

        expect(result.filePath).toContain('job-456.ogg');
        expect(result.originalName).toBe('stream');
    });

    it('throws error if response is not ok', async () => {
        global.fetch = mock(async () => {
            return new Response(null, {
                status: 404,
                statusText: 'Not Found'
            });
        }) as any;

        expect(downloadAudio('https://example.com/missing.mp3', 'job-789'))
            .rejects.toThrow('Failed to download audio: 404 Not Found');
    });

    it('throws error if file exceeds max size', async () => {
        // Mock a large array buffer
        const largeSize = (config.MAX_FILE_SIZE_MB * 1024 * 1024) + 1;
        global.fetch = mock(async () => {
            return {
                ok: true,
                headers: new Headers({ 'content-type': 'audio/wav' }),
                arrayBuffer: async () => new ArrayBuffer(largeSize)
            };
        }) as any;

        expect(downloadAudio('https://example.com/huge.wav', 'job-huge'))
            .rejects.toThrow(`Downloaded file exceeds maximum size of ${config.MAX_FILE_SIZE_MB}MB`);
    });
});
