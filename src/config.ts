interface Config {
    PORT: number;
    DATABASE_URL: string;
    BASIC_AUTH_USER: string;
    BASIC_AUTH_PASS: string;
    MAX_FILE_SIZE_MB: number;
    STORAGE_DIR: string;
    WHISPER_MODEL_PATH: string;
    WHISPER_BINARY_PATH: string;
    WORKER_POLL_INTERVAL_MS: number;
    TRANSCRIBE_TIMEOUT_SEC: number;
    DOWNLOAD_TIMEOUT_SEC: number;
    MAX_ATTEMPTS: number;
    CLEANUP_RETENTION_DAYS: number;
    CLEANUP_INTERVAL_HOURS: number;
}

function parseNumber(value: string | undefined, defaultValue: number, name: string): number {
    if (value === undefined || value === '') return defaultValue;
    const num = Number(value);
    if (Number.isNaN(num)) {
        throw new Error(`Invalid numeric value for ${name}`);
    }
    if (num < 0) {
        throw new Error(`Negative value not allowed for ${name}`);
    }
    return num;
}

function parseString(value: string | undefined, defaultValue: string): string {
    if (value === undefined || value === '') return defaultValue;
    return value;
}

function parseRequiredString(value: string | undefined, name: string): string {
    if (value === undefined || value === '') {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

export const loadConfig = (): Config => {
    return {
        PORT: parseNumber(Bun.env.PORT, 3000, 'PORT'),
        DATABASE_URL: parseRequiredString(Bun.env.DATABASE_URL, 'DATABASE_URL'),
        BASIC_AUTH_USER: parseRequiredString(Bun.env.BASIC_AUTH_USER, 'BASIC_AUTH_USER'),
        BASIC_AUTH_PASS: parseRequiredString(Bun.env.BASIC_AUTH_PASS, 'BASIC_AUTH_PASS'),
        MAX_FILE_SIZE_MB: parseNumber(Bun.env.MAX_FILE_SIZE_MB, 20, 'MAX_FILE_SIZE_MB'),
        STORAGE_DIR: parseString(Bun.env.STORAGE_DIR, '/data/audio'),
        WHISPER_MODEL_PATH: parseString(Bun.env.WHISPER_MODEL_PATH, '/models/ggml-small.bin'),
        WHISPER_BINARY_PATH: parseString(Bun.env.WHISPER_BINARY_PATH, 'whisper-cli'),
        WORKER_POLL_INTERVAL_MS: parseNumber(Bun.env.WORKER_POLL_INTERVAL_MS, 3000, 'WORKER_POLL_INTERVAL_MS'),
        TRANSCRIBE_TIMEOUT_SEC: parseNumber(Bun.env.TRANSCRIBE_TIMEOUT_SEC, 300, 'TRANSCRIBE_TIMEOUT_SEC'),
        DOWNLOAD_TIMEOUT_SEC: parseNumber(Bun.env.DOWNLOAD_TIMEOUT_SEC, 120, 'DOWNLOAD_TIMEOUT_SEC'),
        MAX_ATTEMPTS: parseNumber(Bun.env.MAX_ATTEMPTS, 3, 'MAX_ATTEMPTS'),
        CLEANUP_RETENTION_DAYS: parseNumber(Bun.env.CLEANUP_RETENTION_DAYS, 7, 'CLEANUP_RETENTION_DAYS'),
        CLEANUP_INTERVAL_HOURS: parseNumber(Bun.env.CLEANUP_INTERVAL_HOURS, 1, 'CLEANUP_INTERVAL_HOURS'),
    };
};

export const config = loadConfig();
