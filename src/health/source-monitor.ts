/**
 * External service health monitor.
 * Checks connectivity to Slack, ClickUp, and Qdrant without LLM calls.
 * Alerts via Telegram on failures.
 */

import { sendTelegramMessage } from '../telegram/sender.js'
import { logger } from '../logging/logger.js'
import { SLACK_WORKSPACES } from '../mcp/briefing/slack.js'

interface HealthResult {
  service: string
  ok: boolean
  error?: string
}

async function checkSlack(): Promise<HealthResult[]> {
  const results: HealthResult[] = []
  for (const ws of SLACK_WORKSPACES) {
    try {
      const resp = await fetch('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${ws.token}` },
        signal: AbortSignal.timeout(10_000),
      })
      const data = (await resp.json()) as { ok: boolean }
      results.push({ service: `Slack ${ws.label.toUpperCase()}`, ok: data.ok })
    } catch (error) {
      results.push({
        service: `Slack ${ws.label.toUpperCase()}`,
        ok: false,
        error: String(error),
      })
    }
  }
  return results
}

async function checkClickUp(): Promise<HealthResult> {
  try {
    const key = process.env.CLICKUP_API_KEY
    if (!key) return { service: 'ClickUp', ok: false, error: 'No API key' }
    const resp = await fetch('https://api.clickup.com/api/v2/user', {
      headers: { Authorization: key },
      signal: AbortSignal.timeout(10_000),
    })
    return { service: 'ClickUp', ok: resp.ok }
  } catch (error) {
    return { service: 'ClickUp', ok: false, error: String(error) }
  }
}

async function checkQdrant(): Promise<HealthResult> {
  try {
    const url = process.env.QDRANT_URL ?? 'http://localhost:6333'
    const resp = await fetch(`${url}/healthz`, {
      signal: AbortSignal.timeout(5_000),
    })
    return { service: 'Qdrant', ok: resp.ok }
  } catch (error) {
    return { service: 'Qdrant', ok: false, error: String(error) }
  }
}

async function checkGoogle(): Promise<HealthResult[]> {
  const results: HealthResult[] = []
  try {
    const { resolveGoogleTokens } = await import('../mcp/briefing/google-auth.js')
    const tokens = await resolveGoogleTokens()
    if (tokens.size === 0) {
      results.push({ service: 'Google OAuth', ok: false, error: 'No accounts configured' })
      return results
    }
    // Actually test each token with a real Gmail API call
    for (const [account, token] of tokens) {
      try {
        const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        })
        if (resp.ok) {
          results.push({ service: `Gmail (${account})`, ok: true })
        } else {
          const body = await resp.text().catch(() => '')
          results.push({ service: `Gmail (${account})`, ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 100)}` })
        }
      } catch (error) {
        results.push({ service: `Gmail (${account})`, ok: false, error: String(error) })
      }
    }
  } catch (error) {
    results.push({ service: 'Google OAuth', ok: false, error: String(error) })
  }
  return results
}

async function checkNotion(): Promise<HealthResult> {
  try {
    const token = process.env.NOTION_TOKEN
    if (!token) return { service: 'Notion', ok: true } // optional service, no token = skip
    const resp = await fetch('https://api.notion.com/v1/users/me', {
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
      signal: AbortSignal.timeout(10_000),
    })
    return { service: 'Notion', ok: resp.ok }
  } catch (error) {
    return { service: 'Notion', ok: false, error: String(error) }
  }
}

async function checkClockify(): Promise<HealthResult> {
  try {
    const key = process.env.CLOCKIFY_API_KEY
    if (!key) return { service: 'Clockify', ok: true } // optional
    const resp = await fetch('https://api.clockify.me/api/v1/user', {
      headers: { 'X-Api-Key': key },
      signal: AbortSignal.timeout(10_000),
    })
    return { service: 'Clockify', ok: resp.ok }
  } catch (error) {
    return { service: 'Clockify', ok: false, error: String(error) }
  }
}

export async function runHealthCheck(): Promise<void> {
  const results: HealthResult[] = [
    ...(await checkSlack()),
    await checkClickUp(),
    await checkQdrant(),
    ...(await checkGoogle()),
    await checkNotion(),
    await checkClockify(),
  ]

  const failed = results.filter((r) => !r.ok)
  if (failed.length === 0) {
    logger.info({ services: results.length }, 'Health check: all services OK')
    return
  }

  const msg = `\u26a0\ufe0f <b>Service Health Alert</b>\n\n${failed
    .map((f) => `\u2022 <b>${f.service}</b>: ${f.error ?? 'unavailable'}`)
    .join('\n')}`

  try {
    await sendTelegramMessage(msg)
  } catch {
    logger.error('Failed to send health alert to Telegram')
  }

  logger.warn(
    { failed: failed.map((f) => f.service) },
    'Health check: services down',
  )
}
