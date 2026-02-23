import pino from 'pino'

const level = process.env.LOG_LEVEL ?? 'info'
const isDevelopment = process.env.NODE_ENV === 'development'

/**
 * Base Pino logger instance with redaction of sensitive fields.
 * In development, uses pino-pretty for human-readable output.
 *
 * All request-scoped logging should use createRequestLogger() to get
 * a child logger with a correlation ID.
 */
export const logger = pino({
  level,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label: string) {
      return { level: label }
    },
  },
  redact: {
    paths: [
      '*.token',
      '*.apiKey',
      '*.password',
      '*.secret',
      '*.encryptionKey',
      '*.ciphertext',
    ],
    censor: '[REDACTED]',
  },
  ...(isDevelopment
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
          },
        },
      }
    : {}),
})
