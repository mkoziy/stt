import { mock } from 'bun:test';

// Common mock for Bun.spawn
export const mockSpawn = mock((args: string[], options: any) => {
    return {
        exited: Promise.resolve(0),
        stdout: null,
        stderr: null,
        kill: () => { },
    } as any;
});

// We can assign our mock spawn into Bun globally before tests if needed
