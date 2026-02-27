import type { Config } from 'drizzle-kit';

export default {
    schema: './src/db/schema.ts',
    out: './drizzle/migrations',
    dialect: 'postgresql',
} satisfies Config;
