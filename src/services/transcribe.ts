import { config } from '../config';

export async function transcribeAudio(wavPath: string, language?: string | null): Promise<string> {
    const args = [
        config.WHISPER_BINARY_PATH,
        '-m', config.WHISPER_MODEL_PATH,
        '-f', wavPath,
        '--output-txt',
        '--no-timestamps',
    ];

    if (language) {
        args.push('-l', language);
    }

    const proc = Bun.spawn(args, {
        stdout: 'pipe',
        stderr: 'pipe',
    });

    let stdout = '';
    let stderr = '';

    const timeoutId = setTimeout(() => proc.kill(), config.TRANSCRIBE_TIMEOUT_SEC * 1000);

    const readStream = async (stream: ReadableStream, target: 'stdout' | 'stderr') => {
        const reader = stream.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) {
                    const str = new TextDecoder().decode(value);
                    if (target === 'stdout') stdout += str;
                    else stderr += str;
                }
            }
        } finally {
            reader.releaseLock();
        }
    };

    await Promise.all([
        proc.stdout ? readStream(proc.stdout, 'stdout') : Promise.resolve(),
        proc.stderr ? readStream(proc.stderr, 'stderr') : Promise.resolve(),
    ]);

    const exitCode = await proc.exited;
    clearTimeout(timeoutId);

    if (exitCode !== 0) {
        // If process was killed due to timeout, it'll have specific exit codes / non-zero
        if (exitCode === null || exitCode === 9 || exitCode === 15) { // typical sigkill / sigterm
            throw new Error(`Transcription timed out after ${config.TRANSCRIBE_TIMEOUT_SEC} seconds`);
        }
        throw new Error(`whisper.cpp failed (code ${exitCode}):\n${stderr}`);
    }

    // stdout mostly contains logs and text output (though mostly whisper logs to stderr and leaves pure text in stdout if piped properly)
    // we are reading output since no-timestamps forces text output to stdout.
    // actually `--output-txt` writes to `{wavPath}.txt` by whisper.cpp natively. But stdout mode usually prints pure text.
    // Wait, whisper-cli `--output-txt` creates a `.txt` file alongside the wav file!
    // Let's read from the generated file.

    // The output text file from whisper.cpp is usually path/to/file.wav.txt depending on how --output-txt behaves.
    // Since we also captured stdout, we could just read the .txt file.
    const txtPath = `${wavPath}.txt`;
    const txtFile = Bun.file(txtPath);
    let resultText = stdout.trim();

    if (await txtFile.exists()) {
        resultText = await txtFile.text();
        resultText = resultText.trim();
    }

    return resultText;
}
