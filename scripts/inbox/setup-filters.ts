/**
 * Create Gmail labels and filters for both accounts.
 *
 * Idempotent: existing labels/filters with the same definition are not duplicated.
 *
 * Usage:
 *   tsx scripts/inbox/setup-filters.ts                # dry-run (default)
 *   tsx scripts/inbox/setup-filters.ts --apply        # actually create
 *   tsx scripts/inbox/setup-filters.ts --account dariy@astrocat.co --apply
 */
import { readFileSync } from 'node:fs'

try {
  const envRaw = readFileSync('.env', 'utf-8')
  for (const line of envRaw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (!m) continue
    const [, key, rawVal] = m
    if (process.env[key]) continue
    let val = rawVal
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    process.env[key] = val
  }
} catch { /* ignore */ }

const { resolveGoogleTokens } = await import('../../src/mcp/briefing/google-auth.js')

interface Args {
  apply: boolean
  account: string | null
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  let apply = false
  let account: string | null = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') apply = true
    else if (argv[i] === '--account') account = argv[++i]
  }
  return { apply, account }
}

interface LabelSpec {
  name: string
  listHidden?: boolean
}

const LABELS: LabelSpec[] = [
  { name: 'Auto' },
  { name: 'Auto/Filtered' },
  { name: 'Auto/TestFlight' },
  { name: 'Auto/Calendar RSVP' },
  { name: 'Auto/Netflix Partner' },
  { name: 'Auto/Apple Developer' },
  { name: 'Outsource QA' },
]

interface FilterSpec {
  name: string // for logging only
  criteria: {
    from?: string
    subject?: string
    query?: string
  }
  action: {
    addLabelName: string
    markAsRead: boolean
    removeFromInbox: boolean
  }
}

// === FILTER DEFINITIONS ===
// These are applied via Gmail API; `criteria.from` supports OR via `{ a@x b@y }` syntax
// and parentheses. `criteria.subject` is substring-matched by Gmail.

// Senders confirmed by user as noise (Batch A)
const NOISE_SENDERS_ALL = [
  'clockify@mail.cake.com',
  'noreply-analytics@google.com',
  'team@mail.clickup.com',
  'feedback@slack.com',
  'info@e.atlassian.com',
  'no-reply@account.pagerduty.com',
  'team@hello.notion.so',
  'workspace-noreply@google.com',
  'notification@slack.com',
  'news@gamelightinsights.io',
  'team@mail.notion.so',
  'cloudplatform-noreply@google.com',
  'info@site.hh.ru',
  'anastasia@ganttpro.com',
  'polina@ganttpro.com',
  'levelone@highground.games',
  // Batch added 2026-04-27 (round 3): user reclassified after seeing full list
  'no-reply@pagerduty.com',
  'support@datadog.zendesk.com',
  'notifications@calendly.com',
  'email@mail.hidemy.name',
  // Batch added 2026-04-27 from full-history audit (HG marketing backlog)
  'marketing@usercentrics.com',
  'hello@hgconf.com',
  'team@eml.atlassian.com',
  'info@make.com',
  'team@mail.airtable.com',
  'blog@send.zapier.com',
  'learn@send.zapier.com',
  'teamzoom@e.zoom.us',
  'ines@mail.clickup.com',
  'raphael@mail.notion.so',
  'info@admin.manus.im',
  'consultants@mail.clickup.com',
  'events@send.zapier.com',
  'admin@email.pdfsimpli.com',
  'info@news.manus.im',
  'feedback@midjourney.com',
  'success@monosnap.com',
  'news@send.zapier.com',
  'digitaladoption@clickup.com',
  'info@ludo.ai',
  'contact@zapier.com',
  'team@testrail.com',
  'confluence@tiltingpoint.atlassian.net',
  'noreply@steampowered.com',
  'noreply@geoguessr.com',
  'no-reply@communication.microsoft.com',
  'aleksandar.olic@clockify.me',
  // Batch added 2026-04-27 from 90d audit
  'service@youtrack.cloud',
  'no_reply@email.heygen.com',
  'youtrack-feedback@jetbrains.com',
  'david.diaz@usercentrics.com',
  'noreply@campaign.eventbrite.com',
  'news@jetbrains.com',
  'lehmann.e@scale-ultb.com',
  'webinar@learn.heygen.com',
  'support@fly.io',
  'community@heygen.com',
  'adjust-noreply@adjust.com',
  'hi@betterstackhq.com',
  'weekly@weekly.betterstack.com',
  'team@news.fly.io',
  'googleflow-noreply@google.com',
  'notification@tripo3d.com',
  'magic@huntflow.ai',
]

// Senders user confirmed as "read via filter, digest may still surface via whitelist" (Batch B first 7)
const NOISE_SENDERS_BACKED_BY_DIGEST = [
  'no_reply@email.apple.com',
  'noreply-play-developer-console@google.com',
  'no-reply-googleplay-developer@google.com',
  'noreply-play-console@google.com',
  'no-reply@email.slackhq.com',
  'comments-noreply@docs.google.com',
]

const TESTFLIGHT_SENDER = 'testflight_no_reply@email.apple.com'

const OUTSOURCE_QA_SENDERS = [
  'agamulo@tiltingpoint.com',
  'nisha.ubaid@indium.tech',
  'ramzy.a@indium.tech',
  'jijo.m@indium.tech',
]

const CALENDAR_RSVP_SUBJECTS = [
  '"Accepted:"',
  '"Declined:"',
]

function buildFilters(): FilterSpec[] {
  const filters: FilterSpec[] = []

  // Auto/Filtered: batch A (pure noise) + batch B (digest-backed noise), one filter per sender
  // Gmail allows combining multiple from: via {} but per-sender filters let user remove individually later.
  const filteredSenders = [...NOISE_SENDERS_ALL, ...NOISE_SENDERS_BACKED_BY_DIGEST]
  for (const sender of filteredSenders) {
    filters.push({
      name: `Filtered: ${sender}`,
      criteria: { from: sender },
      action: { addLabelName: 'Auto/Filtered', markAsRead: true, removeFromInbox: true },
    })
  }

  // TestFlight
  filters.push({
    name: `TestFlight`,
    criteria: { from: TESTFLIGHT_SENDER },
    action: { addLabelName: 'Auto/TestFlight', markAsRead: true, removeFromInbox: true },
  })

  // Outsource QA — one filter per sender, applies label, skips inbox
  for (const sender of OUTSOURCE_QA_SENDERS) {
    filters.push({
      name: `Outsource QA: ${sender}`,
      criteria: { from: sender },
      action: { addLabelName: 'Outsource QA', markAsRead: true, removeFromInbox: true },
    })
  }

  // Calendar RSVP auto-responses (Accepted:/Declined: in subject)
  // Use a single filter per subject prefix; applies to all senders.
  for (const subj of CALENDAR_RSVP_SUBJECTS) {
    filters.push({
      name: `Calendar RSVP: ${subj}`,
      criteria: { subject: subj },
      action: { addLabelName: 'Auto/Calendar RSVP', markAsRead: true, removeFromInbox: true },
    })
  }

  // ClickUp 2FA codes — match the 'Sign into ClickUp:' subject so we catch
  // any alias they ever use, not just one numbered help+NNN address.
  filters.push({
    name: `ClickUp 2FA codes`,
    criteria: { from: 'help@clickup.com', subject: '"Sign into ClickUp"' },
    action: { addLabelName: 'Auto/Filtered', markAsRead: true, removeFromInbox: true },
  })

  // Netflix Partner updates — mark-read, route to dedicated label, out of inbox
  filters.push({
    name: `Netflix Partner`,
    criteria: { from: 'info@partner.netflix.com' },
    action: { addLabelName: 'Auto/Netflix Partner', markAsRead: true, removeFromInbox: true },
  })

  // Apple Developer compliance/news — KEEP UNREAD, just route out of inbox
  filters.push({
    name: `Apple Developer`,
    criteria: { from: 'developer@insideapple.apple.com' },
    action: { addLabelName: 'Auto/Apple Developer', markAsRead: false, removeFromInbox: true },
  })

  return filters
}

async function gmailApi<T>(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  if (!resp.ok) {
    throw new Error(`${path} failed: ${resp.status} ${await resp.text()}`)
  }
  const text = await resp.text()
  if (!text) return {} as T
  return JSON.parse(text) as T
}

async function ensureLabels(
  token: string,
  account: string,
  apply: boolean,
): Promise<Map<string, string>> {
  const existing = await gmailApi<{ labels: Array<{ id: string; name: string }> }>(token, '/labels')
  const byName = new Map(existing.labels.map(l => [l.name, l.id]))

  for (const spec of LABELS) {
    if (byName.has(spec.name)) {
      console.log(`  [${account}] label exists: ${spec.name}`)
      continue
    }
    if (!apply) {
      console.log(`  [${account}] would create label: ${spec.name}`)
      continue
    }
    const created = await gmailApi<{ id: string; name: string }>(token, '/labels', {
      method: 'POST',
      body: {
        name: spec.name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      },
    })
    byName.set(created.name, created.id)
    console.log(`  [${account}] created label: ${spec.name} (${created.id})`)
  }
  return byName
}

interface ExistingFilter {
  id: string
  criteria?: Record<string, unknown>
  action?: Record<string, unknown>
}

async function ensureFilters(
  token: string,
  account: string,
  labelIds: Map<string, string>,
  filters: FilterSpec[],
  apply: boolean,
): Promise<void> {
  const existing = await gmailApi<{ filter?: ExistingFilter[] }>(token, '/settings/filters')
  const existingFilters = existing.filter ?? []

  for (const spec of filters) {
    const labelId = labelIds.get(spec.action.addLabelName)
    if (!labelId) {
      console.log(`  [${account}] SKIP (label not yet created): ${spec.name}`)
      continue
    }
    // Check if an identical filter already exists
    const exists = existingFilters.some(f => {
      const c = f.criteria ?? {}
      const a = f.action ?? {}
      const cMatches =
        (spec.criteria.from === undefined || c.from === spec.criteria.from) &&
        (spec.criteria.subject === undefined || c.subject === spec.criteria.subject) &&
        (spec.criteria.query === undefined || c.query === spec.criteria.query)
      const addLabelIds = (a.addLabelIds as string[] | undefined) ?? []
      const removeLabelIds = (a.removeLabelIds as string[] | undefined) ?? []
      const aMatches =
        addLabelIds.includes(labelId) &&
        (spec.action.markAsRead ? removeLabelIds.includes('UNREAD') : true) &&
        (spec.action.removeFromInbox ? removeLabelIds.includes('INBOX') : true)
      return cMatches && aMatches
    })
    if (exists) {
      console.log(`  [${account}] filter exists: ${spec.name}`)
      continue
    }

    const body: any = {
      criteria: { ...spec.criteria },
      action: {
        addLabelIds: [labelId],
        removeLabelIds: [
          ...(spec.action.markAsRead ? ['UNREAD'] : []),
          ...(spec.action.removeFromInbox ? ['INBOX'] : []),
        ],
      },
    }
    if (!apply) {
      console.log(`  [${account}] would create filter: ${spec.name}`)
      continue
    }
    const created = await gmailApi<{ id: string }>(token, '/settings/filters', {
      method: 'POST',
      body,
    })
    console.log(`  [${account}] created filter: ${spec.name} (${created.id})`)
  }
}

async function main() {
  const args = parseArgs()
  const tokens = await resolveGoogleTokens()
  if (tokens.size === 0) throw new Error('No Google accounts authorized')

  const mode = args.apply ? 'APPLY' : 'DRY-RUN'
  console.log(`\n[${mode}] setting up labels and filters\n`)

  const filters = buildFilters()
  console.log(`Labels to ensure: ${LABELS.map(l => l.name).join(', ')}`)
  console.log(`Filters to ensure: ${filters.length} total\n`)

  for (const [account, token] of tokens) {
    if (args.account && account !== args.account) continue
    console.log(`=== ${account} ===`)
    const labelIds = await ensureLabels(token, account, args.apply)
    await ensureFilters(token, account, labelIds, filters, args.apply)
    console.log()
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
