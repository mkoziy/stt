import { Hono } from 'hono';

const healthApp = new Hono();

healthApp.get('/', (c) => {
    return c.json({
        status: 'ok',
        service: 'stt-api'
    });
});

export default healthApp;
