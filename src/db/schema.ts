import { pgTable, uuid, text, integer, timestamp, pgEnum } from 'drizzle-orm/pg-core';

export const statusEnum = pgEnum('status', ['pending', 'processing', 'completed', 'failed']);
export const sourceTypeEnum = pgEnum('source_type', ['upload', 'url']);

export const jobs = pgTable('jobs', {
    id: uuid('id').primaryKey().defaultRandom(),
    status: statusEnum('status').notNull().default('pending'),
    source_type: sourceTypeEnum('source_type').notNull(),
    source_url: text('source_url'),
    original_name: text('original_name'),
    file_path: text('file_path').notNull(),
    wav_path: text('wav_path'),
    language: text('language'),
    result_text: text('result_text'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    max_attempts: integer('max_attempts').notNull(),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
});
