import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { transcribeAudio } from '../../../src/services/transcribe';
import { mockSpawn } from '../../helpers/mocks';
import { config } from '../../../src/config';

describe('transcribe service', () => {
    let originalBunSpawn: typeof Bun.spawn;
    let originalBunFile: typeof Bun.file;

    beforeEach(() => {
        originalBunSpawn = Bun.spawn;
        originalBunFile = Bun.file;
    });

    afterEach(() => {
        Bun.spawn = originalBunSpawn;
        Bun.file = originalBunFile;
    });

    it('transcribes file successfully falling back to txt file', async () => {
        // Mock child process that doesn't output to stdout directly
        const localMock = mock(() => {
            return {
                exited: Promise.resolve(0),
                stdout: null,
                stderr: null,
                kill: () => { },
            };
        });
        Bun.spawn = localMock as any;

        // Mock bun file to return "Hello World"
        const mockFile = mock(async () => true);
        const mockText = mock(async () => "Hello World\n");
        Bun.file = mock(() => ({
            exists: mockFile,
            text: mockText
        })) as any;

        const result = await transcribeAudio('/dummy.wav', 'en');

        expect(localMock).toHaveBeenCalled();
        const args = localMock.mock.calls[0][0];
        expect(args).toContain(config.WHISPER_BINARY_PATH);
        expect(args).toContain('-l');
        expect(args).toContain('en');

        expect(result).toBe('Hello World');
    });

    it('transcribes file successfully using stdout stream if txt file doesnt exist', async () => {
        // Prepare mock stdout
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("Hello Stdout\n"));
                controller.close();
            }
        });

        const localMock = mock(() => {
            return {
                exited: Promise.resolve(0),
                stdout: stream,
                stderr: null,
                kill: () => { },
            };
        });
        Bun.spawn = localMock as any;

        // Mock bun file to return false for existence
        Bun.file = mock(() => ({
            exists: mock(async () => false)
        })) as any;

        const result = await transcribeAudio('/dummy.wav');

        expect(result).toBe('Hello Stdout');
    });

    it('throws error if whisper fails', async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("Error log"));
                controller.close();
            }
        });

        const localMock = mock(() => {
            return {
                exited: Promise.resolve(1),
                stdout: null,
                stderr: stream,
                kill: () => { },
            };
        });
        Bun.spawn = localMock as any;

        expect(transcribeAudio('/dummy.wav'))
            .rejects.toThrow('whisper.cpp failed (code 1):\nError log');
    });

    it('throws custom timeout error on specific exit codes', async () => {
        const localMock = mock(() => {
            return {
                exited: Promise.resolve(9),
                stdout: null,
                stderr: null,
                kill: () => { },
            };
        });
        Bun.spawn = localMock as any;

        expect(transcribeAudio('/dummy.wav'))
            .rejects.toThrow(`Transcription timed out after ${config.TRANSCRIBE_TIMEOUT_SEC} seconds`);
    });
});
