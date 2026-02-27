import { Hono } from 'hono';
import { logger } from 'hono/logger';
import healthApp from './routes/health';
import jobsApp from './routes/jobs';
import { authMiddleware } from './middleware/auth';
import { runCleanup } from './services/cleanup';
import { config } from './config';

const app = new Hono();

app.use('*', logger());

// Public routes
app.route('/health', healthApp);

// Protected routes
app.use('/jobs/*', authMiddleware);
app.route('/jobs', jobsApp);

// Start cleanup cron
const cleanupIntervalMs = config.CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000;
setInterval(() => {
    runCleanup().catch((err) => console.error('Cleanup cron failed:', err));
}, cleanupIntervalMs);

console.log(`API starting on port ${config.PORT}`);
console.log(`Cleanup cron scheduled every ${config.CLEANUP_INTERVAL_HOURS} hour(s)`);

export default {
    port: config.PORT,
    fetch: app.fetch,
};
