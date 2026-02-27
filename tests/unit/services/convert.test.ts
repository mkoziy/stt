import { describe, it, expect, mock, spyOn } from 'bun:test';
import { convertToWav } from '../../../src/services/convert';
import { mockSpawn } from '../../helpers/mocks';

spyOn(Bun, 'spawn').mockImplementation(mockSpawn as any);

describe('convert service', () => {
    it('calls ffmpeg with correct parameters', async () => {
        // Override spawn specifically for this test
        const localMock = mock(() => {
            return { exited: Promise.resolve(0), stdout: null, stderr: null, kill: () => { } };
        });
        Bun.spawn = localMock as any;

        await convertToWav('/dummy.mp3', 'test-uuid-123');

        expect(localMock).toHaveBeenCalled();
        const args = localMock.mock.calls[0][0];
        // Check if args array contains ffmpeg
        expect(args[0]).toBe('ffmpeg');
        expect(args).toContain('16000');
        expect(args).toContain('-ac');
        expect(args).toContain('1');
    });
});
