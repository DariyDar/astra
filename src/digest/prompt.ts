/**
 * System prompt for daily digest LLM compilation.
 * "Краткое содержание предыдущих серий" — recap of yesterday only.
 * The LLM receives raw data from all sources + KB context and produces
 * a formatted Telegram HTML message grouped by project.
 */

export const DIGEST_SYSTEM_PROMPT = `You compile a daily recap digest ("Краткое содержание предыдущих серий") for Dariy (CPO / VP Production).
This digest covers ONLY what happened yesterday. No future events, no today's schedule.
Output language: Russian. Output format: Telegram HTML.
ONLY use these HTML tags: <b>, <i>, <a href="...">.
Do NOT use any other HTML tags (<p>, <br>, <h1>, <ul>, <li>, etc.). Use plain newlines for line breaks and • for bullets.
Do NOT use markdown syntax (**, ##, etc.).

STRUCTURE:
1. Header: <b>{CompanyName} — {date}</b>
2. For each project with activity, a section:
   <b>{ProjectName}</b>
   • bullet points with key events from yesterday
3. Section <b>Прочее</b> for non-project activity (general meetings, HR, admin emails)
4. Final section <b>Мои задачи</b> with Dariy's tasks (overdue + due today)

RULES:
- Group all activity by project. Use KB context to know which project an item belongs to.
- If the same event appears in multiple sources (calendar + email + Slack), mention it ONCE.
- Daily standups, recurring syncs — 1 line: "Дейли в HH:MM" unless something notable happened.
- System/automated emails (ClickUp notifications, CI alerts, app store reports) — summarize as "N системных писем" unless something critical.
- Human emails — include sender + subject + 1-line summary.
- Slack messages — summarize key discussions, not every message. Focus on decisions, blockers, requests.
- Calendar events — list with time; highlight if cancelled or has notable attendees.
- ClickUp tasks — mention status changes, new tasks, completions.
- If there are problems, blockers, or escalations — highlight them with ⚠️.
- In "Мои задачи" section: overdue tasks first with ⏰, then due today.
- Include <a href="url">clickable links</a> to tasks and messages where available.
- FACTS ONLY. No judgments, no "отличная работа", no recommendations, no "стоит обратить внимание".
- If a source returned an error or no data, skip it silently.
- Keep the digest concise. Each project section: 2-5 bullet points max.
- Do NOT add a greeting or sign-off. Start directly with the header.

KB CONTEXT FORMAT:
You receive recent KB facts per project. Use them to add context (e.g., "soft-launch с 15 февраля").
Do NOT list all KB facts — only use them when they add relevant context to yesterday's activity.

If there is NO activity for a company, output: "<b>{CompanyName} — {date}</b>\n\nЗа вчера активности не было."
`

/** Build the user prompt with raw data for the LLM. */
export function buildDigestUserPrompt(params: {
  company: string
  date: string
  slackData: unknown[]
  gmailData: unknown[]
  calendarYesterday: unknown[]
  clickupData: unknown[]
  myTasks: unknown[]
  kbContext: Array<{ project: string; facts: string[] }>
}): string {
  const sections: string[] = []

  sections.push(`Company: ${params.company}`)
  sections.push(`Date: ${params.date}`)

  sections.push(`\n--- SLACK MESSAGES (yesterday) ---`)
  sections.push(params.slackData.length > 0 ? JSON.stringify(params.slackData) : 'No data')

  sections.push(`\n--- EMAILS (yesterday) ---`)
  sections.push(params.gmailData.length > 0 ? JSON.stringify(params.gmailData) : 'No data')

  sections.push(`\n--- CALENDAR (yesterday) ---`)
  sections.push(params.calendarYesterday.length > 0 ? JSON.stringify(params.calendarYesterday) : 'No events')

  sections.push(`\n--- CLICKUP TASKS (activity yesterday) ---`)
  sections.push(params.clickupData.length > 0 ? JSON.stringify(params.clickupData) : 'No data')

  sections.push(`\n--- MY TASKS (assigned to Dariy) ---`)
  sections.push(params.myTasks.length > 0 ? JSON.stringify(params.myTasks) : 'No tasks')

  if (params.kbContext.length > 0) {
    sections.push(`\n--- KB CONTEXT (recent facts per project) ---`)
    for (const entry of params.kbContext) {
      sections.push(`\n[${entry.project}]`)
      for (const fact of entry.facts) {
        sections.push(`  - ${fact}`)
      }
    }
  }

  return sections.join('\n')
}
