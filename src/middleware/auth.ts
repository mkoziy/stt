import { basicAuth } from 'hono/basic-auth';
import { config } from '../config';

export const authMiddleware = basicAuth({
    username: config.BASIC_AUTH_USER,
    password: config.BASIC_AUTH_PASS,
});
