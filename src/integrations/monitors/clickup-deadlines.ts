import cron from 'node-cron'
import { logger } from '../../logging/logger.js'
import type { NotificationDispatcher } from '../../notifications/dispatcher.js'
import type { NotificationItem } from '../../notifications/urgency.js'

/** Minimal shape of a ClickUp task from the REST API */
interface ClickUpTask {
  id: string
  name: string
  due_date: string | null
  status: { status: string }
  assignees: Array<{ username: string }>
  url: string
  list: { name: string }
}

interface ClickUpDeadlineMonitorConfig {
  apiKey: string
  teamId: string
  dispatcher: NotificationDispatcher
  adminUserId: string
}

const CLICKUP_BASE_URL = 'https://api.clickup.com/api/v2'
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

/**
 * Monitors ClickUp for tasks with approaching or overdue deadlines.
 *
 * Runs every 30 minutes via node-cron, queries the ClickUp REST API directly
 * (no LLM/Claude calls), and dispatches notifications through NotificationDispatcher.
 *
 * Deduplicates alerts within a session using a Set of notified task IDs.
 * The set resets on bot restart, which is acceptable for this use case.
 */
export class ClickUpDeadlineMonitor {
  private readonly apiKey: string
  private readonly teamId: string
  private readonly dispatcher: NotificationDispatcher
  private readonly adminUserId: string
  private readonly notifiedTaskIds: Set<string> = new Set()
  private cronJob: cron.ScheduledTask | null = null

  constructor(config: ClickUpDeadlineMonitorConfig) {
    this.apiKey = config.apiKey
    this.teamId = config.teamId
    this.dispatcher = config.dispatcher
    this.adminUserId = config.adminUserId
  }

  /**
   * Start the deadline monitor cron job (every 30 minutes).
   * Also runs an immediate check on start.
   */
  start(): void {
    // Run immediately on start
    this.checkDeadlines().catch((error) => {
      logger.error({ error }, 'ClickUp deadline monitor: initial check failed')
    })

    // Schedule every 30 minutes
    this.cronJob = cron.schedule('*/30 * * * *', () => {
      this.checkDeadlines().catch((error) => {
        logger.error({ error }, 'ClickUp deadline monitor: scheduled check failed')
      })
    })

    logger.info('ClickUp deadline monitor started (every 30 minutes)')
  }

  /**
   * Stop the deadline monitor cron job.
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop()
      this.cronJob = null
      logger.info('ClickUp deadline monitor stopped')
    }
  }

  /**
   * Core logic: fetch tasks from ClickUp REST API, categorize by deadline,
   * and dispatch notifications for new overdue/approaching tasks.
   */
  private async checkDeadlines(): Promise<void> {
    try {
      const now = Date.now()
      const dueDateGt = now - SEVEN_DAYS_MS
      const dueDateLt = now + TWENTY_FOUR_HOURS_MS

      const url = new URL(`${CLICKUP_BASE_URL}/team/${this.teamId}/task`)
      url.searchParams.set('due_date_gt', String(dueDateGt))
      url.searchParams.set('due_date_lt', String(dueDateLt))
      url.searchParams.append('statuses[]', 'open')
      url.searchParams.append('statuses[]', 'in progress')
      url.searchParams.set('include_closed', 'false')

      const response = await fetch(url.toString(), {
        headers: { Authorization: this.apiKey },
      })

      if (!response.ok) {
        logger.error(
          { status: response.status, statusText: response.statusText },
          'ClickUp API request failed',
        )
        return
      }

      const data = (await response.json()) as { tasks: ClickUpTask[] }
      const tasks = data.tasks.filter((t) => t.due_date !== null)

      let overdueCount = 0
      let approachingCount = 0

      for (const task of tasks) {
        // Skip already-notified tasks (deduplication within session)
        if (this.notifiedTaskIds.has(task.id)) {
          continue
        }

        const dueDate = Number(task.due_date)
        const isOverdue = dueDate < now
        const isApproaching = !isOverdue && dueDate <= now + TWENTY_FOUR_HOURS_MS

        if (!isOverdue && !isApproaching) {
          continue
        }

        const formattedDate = new Date(dueDate).toLocaleString('ru-RU', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })

        const item: NotificationItem = {
          category: 'task_deadline',
          title: isOverdue ? `Overdue: ${task.name}` : `Due soon: ${task.name}`,
          body: `List: ${task.list.name} | Status: ${task.status.status} | Due: ${formattedDate} | ${task.url}`,
          source: 'clickup',
          createdAt: new Date(),
          metadata: {
            clickupTaskId: task.id,
            isOverdue,
            dueDate,
          },
        }

        await this.dispatcher.dispatch(this.adminUserId, item)
        this.notifiedTaskIds.add(task.id)

        if (isOverdue) {
          overdueCount++
        } else {
          approachingCount++
        }
      }

      logger.info(
        {
          totalTasks: tasks.length,
          overdue: overdueCount,
          approaching: approachingCount,
          notifiedTotal: this.notifiedTaskIds.size,
        },
        'ClickUp deadline check completed',
      )
    } catch (error) {
      logger.error({ error }, 'ClickUp deadline check failed')
    }
  }
}
