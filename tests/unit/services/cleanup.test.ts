import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { runCleanup } from '../../../src/services/cleanup';

const mockDbDeleteReturn = mock(async () => { });
const mockDbWhereReturn = mock(() => ({
    where: mockDbDeleteReturn
}));

const mockDbSelectReturn = mock(async () => []);
const mockDbSelectFrom = mock(() => ({
    from: mock(() => ({
        where: mockDbSelectReturn
    }))
}));
const mockDbSelectFromNoWhere = mock(() => ({
    from: mockDbSelectReturn
}));

// Mock db module
mock.module('../../../src/db', () => ({
    db: {
        select: mock((fields?: any) => {
            if (fields) return mockDbSelectFromNoWhere();
            return mockDbSelectFrom();
        }),
        delete: mock(() => mockDbWhereReturn())
    }
}));

// Mock fs/promises
const mockUnlink = mock(async () => { });
const mockReaddir = mock(async () => ['orphan-12345678-1234-1234-1234-1234567890ab.wav', 'valid-uuid.wav']);
mock.module('node:fs/promises', () => ({
    unlink: mockUnlink,
    readdir: mockReaddir
}));

describe('cleanup service', () => {
    beforeEach(() => {
        mockUnlink.mockClear();
        mockReaddir.mockClear();
        mockDbSelectReturn.mockClear();
        mockDbDeleteReturn.mockClear();
    });

    it('cleans up old jobs from db and filesystem', async () => {
        // First select is for finding old jobs
        const oldJobs = [
            { id: 'job-1', file_path: '/tmp/job-1.mp3', wav_path: '/tmp/job-1.wav' },
            { id: 'job-2', file_path: null, wav_path: '/tmp/job-2.wav' }
        ];

        // Second select is for valid job ids for orphan check
        const validJobIds = [{ id: 'job-1' }, { id: 'job-3' }];

        mockDbSelectReturn.mockResolvedValueOnce(oldJobs as any);
        mockDbSelectReturn.mockResolvedValueOnce(validJobIds as any);
        mockReaddir.mockResolvedValueOnce([]); // No orphans

        await runCleanup();

        expect(mockUnlink).toHaveBeenCalledTimes(3); // job-1.mp3, job-1.wav, job-2.wav
        expect(mockDbDeleteReturn).toHaveBeenCalledTimes(1);
    });

    it('handles gracefully when no old jobs exist', async () => {
        mockDbSelectReturn.mockResolvedValueOnce([]);
        mockDbSelectReturn.mockResolvedValueOnce([{ id: 'job-1' }]);
        mockReaddir.mockResolvedValueOnce([]);

        await runCleanup();

        expect(mockUnlink).not.toHaveBeenCalled();
        expect(mockDbDeleteReturn).not.toHaveBeenCalled();
    });

    it('cleans up orphaned files', async () => {
        // No old jobs DB deletion
        mockDbSelectReturn.mockResolvedValueOnce([]);
        // DB only has 'job-1'
        mockDbSelectReturn.mockResolvedValueOnce([{ id: 'job-1' }]);
        // Filesystem has an orphan UUID that doesn't exist in DB
        const orphanFile = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d.wav';
        mockReaddir.mockResolvedValueOnce([orphanFile, 'invalid-file.txt', 'job-1.wav']);

        await runCleanup();

        expect(mockUnlink).toHaveBeenCalledTimes(1);
    });
});
