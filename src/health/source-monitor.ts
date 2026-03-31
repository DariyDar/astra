/**
 * External service health monitor.
 * Checks ALL services with REAL API calls (not just token presence).
 * Alerts via Telegram on failures with instructions how to fix.
 */

import { sendTelegramMessage } from '../telegram/sender.js'
import { logger } from '../logging/logger.js'
import { SLACK_WORKSPACES } from '../mcp/briefing/slack.js'

interface HealthResult {
  service: string
  ok: boolean
  error?: string
  fix?: string
}

async function checkSlack(): Promise<HealthResult[]> {
  if (SLACK_WORKSPACES.length === 0) {
    return [{ service: 'Slack', ok: false, error: 'No workspaces configured', fix: 'Set SLACK_AC_USER_TOKEN + SLACK_AC_TEAM_ID and SLACK_HG_USER_TOKEN + SLACK_HG_TEAM_ID in .env' }]
  }
  const results: HealthResult[] = []
  for (const ws of SLACK_WORKSPACES) {
    try {
      const resp = await fetch('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${ws.token}` },
        signal: AbortSignal.timeout(10_000),
      })
      const data = (await resp.json()) as { ok: boolean; error?: string }
      if (data.ok) {
        results.push({ service: `Slack ${ws.label.toUpperCase()}`, ok: true })
      } else {
        results.push({ service: `Slack ${ws.label.toUpperCase()}`, ok: false, error: data.error ?? 'auth failed', fix: `Regenerate SLACK_${ws.label.toUpperCase()}_USER_TOKEN in Slack app settings` })
      }
    } catch (error) {
      results.push({ service: `Slack ${ws.label.toUpperCase()}`, ok: false, error: String(error), fix: 'Check server network connectivity to slack.com' })
    }
  }
  return results
}

async function checkClickUp(): Promise<HealthResult> {
  const key = process.env.CLICKUP_API_KEY
  if (!key) return { service: 'ClickUp', ok: false, error: 'CLICKUP_API_KEY not set', fix: 'Add CLICKUP_API_KEY to .env. Get from ClickUp → Settings → Apps → API Token' }
  try {
    const resp = await fetch('https://api.clickup.com/api/v2/user', {
      headers: { Authorization: key },
      signal: AbortSignal.timeout(10_000),
    })
    if (resp.ok) return { service: 'ClickUp', ok: true }
    return { service: 'ClickUp', ok: false, error: `HTTP ${resp.status}`, fix: 'Regenerate CLICKUP_API_KEY in ClickUp → Settings → Apps' }
  } catch (error) {
    return { service: 'ClickUp', ok: false, error: String(error), fix: 'Check network connectivity to api.clickup.com' }
  }
}

async function checkGoogle(): Promise<HealthResult[]> {
  const results: HealthResult[] = []
  try {
    const { resolveGoogleTokens, GOOGLE_ACCOUNTS } = await import('../mcp/briefing/google-auth.js')
    if (GOOGLE_ACCOUNTS.length === 0) {
      results.push({ service: 'Google OAuth', ok: false, error: 'No accounts configured', fix: 'Set GOOGLE_ACCOUNTS in .env' })
      return results
    }
    const tokens = await resolveGoogleTokens()
    // Check EVERY configured account — not just those with valid tokens
    for (const account of GOOGLE_ACCOUNTS) {
      const token = tokens.get(account)
      if (!token) {
        results.push({ service: `Gmail (${account})`, ok: false, error: 'Token missing or expired — needs re-authorization', fix: 'SSH tunnel: ssh -L 8000:localhost:8000 clawdbot@server, then ask Astra to re-authorize' })
        continue
      }
      try {
        const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        })
        if (resp.ok) {
          results.push({ service: `Gmail (${account})`, ok: true })
        } else {
          const body = await resp.text().catch(() => '')
          results.push({ service: `Gmail (${account})`, ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 100)}`, fix: `Re-authorize: open /auth?account=${account} on the bot server, complete OAuth flow` })
        }
      } catch (error) {
        results.push({ service: `Gmail (${account})`, ok: false, error: String(error), fix: 'Check network connectivity to googleapis.com' })
      }
    }
  } catch (error) {
    results.push({ service: 'Google OAuth', ok: false, error: String(error), fix: 'Check GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env' })
  }
  return results
}

async function checkNotion(): Promise<HealthResult> {
  const token = process.env.NOTION_TOKEN
  if (!token) return { service: 'Notion', ok: false, error: 'NOTION_TOKEN not set', fix: 'Add NOTION_TOKEN to .env. Get from notion.so/my-integrations → create integration → copy token' }
  try {
    const resp = await fetch('https://api.notion.com/v1/users/me', {
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
      signal: AbortSignal.timeout(10_000),
    })
    if (resp.ok) return { service: 'Notion', ok: true }
    return { service: 'Notion', ok: false, error: `HTTP ${resp.status}`, fix: 'Regenerate NOTION_TOKEN at notion.so/my-integrations' }
  } catch (error) {
    return { service: 'Notion', ok: false, error: String(error), fix: 'Check network connectivity to api.notion.com' }
  }
}

async function checkClockify(): Promise<HealthResult> {
  const key = process.env.CLOCKIFY_API_KEY
  if (!key) return { service: 'Clockify', ok: false, error: 'CLOCKIFY_API_KEY not set', fix: 'Add CLOCKIFY_API_KEY to .env. Get from clockify.me → Profile → API → Generate' }
  try {
    const resp = await fetch('https://api.clockify.me/api/v1/user', {
      headers: { 'X-Api-Key': key },
      signal: AbortSignal.timeout(10_000),
    })
    if (resp.ok) return { service: 'Clockify', ok: true }
    return { service: 'Clockify', ok: false, error: `HTTP ${resp.status}`, fix: 'Regenerate CLOCKIFY_API_KEY at clockify.me → Profile → API' }
  } catch (error) {
    return { service: 'Clockify', ok: false, error: String(error), fix: 'Check network connectivity to api.clockify.me' }
  }
}

export async function runHealthCheck(): Promise<void> {
  const results: HealthResult[] = [
    ...(await checkSlack()),
    await checkClickUp(),
    ...(await checkGoogle()),
    await checkNotion(),
    await checkClockify(),
  ]

  const failed = results.filter((r) => !r.ok)
  if (failed.length === 0) {
    logger.info({ services: results.length }, 'Health check: all services OK')
    return
  }

  const lines = [`⚠️ <b>Service Health Alert</b>`, '']
  for (const f of failed) {
    lines.push(`• <b>${f.service}</b>: ${f.error ?? 'unavailable'}`)
    if (f.fix) lines.push(`  → <i>${f.fix}</i>`)
  }

  try {
    await sendTelegramMessage(lines.join('\n'))
  } catch {
    logger.error('Failed to send health alert to Telegram')
  }

  logger.warn({ failed: failed.map((f) => f.service) }, 'Health check: services down')
}
