import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { config } from '../config';

const migrationClient = postgres(config.DATABASE_URL, { max: 1 });
const db = drizzle(migrationClient);

async function run() {
    console.log('Running migrations...');
    await migrate(db, { migrationsFolder: 'drizzle/migrations' });
    console.log('Migrations completed.');
    await migrationClient.end();
}

run().catch((err) => {
    console.error('Migration failed');
    console.error(err);
    process.exit(1);
});
