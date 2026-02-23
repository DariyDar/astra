import crypto from 'node:crypto'
import { logger } from './logger.js'
import type pino from 'pino'

interface RequestContext {
  userId?: string
  action?: string
  source?: string
}

/**
 * Create a child logger with a unique correlation ID for request-scoped logging.
 * Every bot message, API call, or background job should create one of these.
 */
export function createRequestLogger(context: RequestContext): pino.Logger {
  const correlationId = crypto.randomUUID()

  return logger.child({
    correlationId,
    ...context,
  })
}
