import { lt } from 'drizzle-orm'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { auditTrail } from '../db/schema.js'
import { logger } from './logger.js'

export interface AuditEntry {
  correlationId: string
  userId?: string
  action: string
  source?: string
  model?: string
  metadata?: Record<string, unknown>
  status: 'success' | 'error' | 'timeout'
  errorMessage?: string
}

/**
 * Write an audit trail entry to PostgreSQL.
 * Fire-and-forget: catches and logs errors but never throws.
 * Audit failure should not break the request flow.
 */
export async function writeAuditEntry(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditTrail).values({
      correlationId: entry.correlationId,
      userId: entry.userId ?? null,
      action: entry.action,
      source: entry.source ?? null,
      model: entry.model ?? null,
      metadata: entry.metadata ?? null,
      status: entry.status,
      errorMessage: entry.errorMessage ?? null,
    })
  } catch (error) {
    logger.error({ error, entry }, 'Failed to write audit entry')
  }
}

/**
 * Retrieve all audit trail entries for a given correlation ID.
 */
export async function queryAuditTrail(
  correlationId: string,
): Promise<AuditEntry[]> {
  const rows = await db
    .select()
    .from(auditTrail)
    .where(eq(auditTrail.correlationId, correlationId))

  return rows.map((row) => ({
    correlationId: row.correlationId,
    userId: row.userId ?? undefined,
    action: row.action,
    source: row.source ?? undefined,
    model: row.model ?? undefined,
    metadata: (row.metadata as Record<string, unknown>) ?? undefined,
    status: row.status as 'success' | 'error' | 'timeout',
    errorMessage: row.errorMessage ?? undefined,
  }))
}

/**
 * Delete audit trail entries older than the specified retention period.
 * Returns the number of entries deleted.
 */
export async function cleanupOldEntries(
  retentionDays: number,
): Promise<number> {
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays)

  const deleted = await db
    .delete(auditTrail)
    .where(lt(auditTrail.createdAt, cutoffDate))
    .returning({ id: auditTrail.id })

  return deleted.length
}
