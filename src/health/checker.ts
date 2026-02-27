import { QdrantClient } from '@qdrant/js-client-rest'
import { Redis } from 'ioredis'
import pg from 'pg'
import { logger } from '../logging/logger.js'
import { sendHealthAlert } from './alerter.js'

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { Pool } = pg

export interface HealthResult {
  service: string
  healthy: boolean
  latencyMs: number
  error?: string
}

/**
 * Health checker that monitors all infrastructure services.
 * Runs checks in parallel and alerts via Telegram on failures.
 */
export class HealthChecker {
  private intervalHandle: ReturnType<typeof setInterval> | null = null

  /**
   * Check all services in parallel and return results.
   * If any service is unhealthy, sends a Telegram alert.
   */
  async checkAll(): Promise<HealthResult[]> {
    const checks = [
      this.checkPostgres(),
      this.checkRedis(),
      this.checkQdrant(),
    ]

    const settled = await Promise.allSettled(checks)

    const results: HealthResult[] = settled.map((result, index) => {
      const serviceName = ['PostgreSQL', 'Redis', 'Qdrant'][index]
      if (result.status === 'fulfilled') {
        return result.value
      }
      return {
        service: serviceName,
        healthy: false,
        latencyMs: 0,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      }
    })

    const unhealthy = results.filter((r) => !r.healthy)
    if (unhealthy.length > 0) {
      const serviceList = unhealthy
        .map((r) => `${r.service}: ${r.error ?? 'unknown error'}`)
        .join('\n')
      await sendHealthAlert(`Unhealthy services detected:\n${serviceList}`)
    }

    return results
  }

  /**
   * Start periodic health checks at the specified interval.
   * Default: 60000ms (1 minute).
   */
  startPeriodicChecks(intervalMs: number = 60_000): void {
    if (this.intervalHandle) {
      return
    }

    logger.info({ intervalMs }, 'Starting periodic health checks')

    this.intervalHandle = setInterval(async () => {
      try {
        const results = await this.checkAll()
        const allHealthy = results.every((r) => r.healthy)
        if (allHealthy) {
          logger.debug('All services healthy')
        }
      } catch (error) {
        logger.error({ error }, 'Health check cycle failed')
      }
    }, intervalMs)
  }

  /**
   * Stop periodic health checks.
   */
  stopPeriodicChecks(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
      logger.info('Stopped periodic health checks')
    }
  }

  private async checkPostgres(): Promise<HealthResult> {
    const start = Date.now()
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 5000,
    })

    try {
      await pool.query('SELECT 1')
      return {
        service: 'PostgreSQL',
        healthy: true,
        latencyMs: Date.now() - start,
      }
    } catch (error) {
      return {
        service: 'PostgreSQL',
        healthy: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      await pool.end()
    }
  }

  private async checkRedis(): Promise<HealthResult> {
    const start = Date.now()
    const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      connectTimeout: 5000,
      maxRetriesPerRequest: 0,
      lazyConnect: true,
    })

    try {
      await redis.connect()
      await redis.ping()
      return {
        service: 'Redis',
        healthy: true,
        latencyMs: Date.now() - start,
      }
    } catch (error) {
      return {
        service: 'Redis',
        healthy: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      redis.disconnect()
    }
  }

  private async checkQdrant(): Promise<HealthResult> {
    const start = Date.now()
    const client = new QdrantClient({ url: process.env.QDRANT_URL ?? 'http://localhost:6333' })

    try {
      // Lightweight operation: list collections (no data transfer)
      await client.getCollections()
      return {
        service: 'Qdrant',
        healthy: true,
        latencyMs: Date.now() - start,
      }
    } catch (error) {
      return {
        service: 'Qdrant',
        healthy: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

}
