import { z } from 'zod'
import 'dotenv/config'

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  ENCRYPTION_KEY: z.string().length(64, 'Must be 32 bytes hex-encoded'),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ADMIN_CHAT_ID: z.string().min(1),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  NODE_ENV: z.enum(['development', 'production']).default('development'),
})

export const env = envSchema.parse(process.env)
export type Env = z.infer<typeof envSchema>

/**
 * Pino redact paths for sensitive fields.
 * Use when creating Pino logger instances.
 */
export const pinoRedactPaths = [
  '*.token',
  '*.apiKey',
  '*.password',
  '*.secret',
  '*.encryptionKey',
]
