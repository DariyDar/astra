import type { Skill } from './types.js'

const clockifySkill: Skill = {
  name: 'clockify',
  description: 'Time tracking reports: hours per person/project, who tracked, who missing',

  triggers: [
    'время', 'часы', 'часов', 'трекинг', 'трекал', 'затрачено',
    'clockify', 'timesheet', 'выгрузка', 'выгрузку',
    'кто работал', 'кто трекал', 'не трекал', 'не залогировал',
    'сколько часов', 'отработал', 'отработали',
  ],

  async preProcess(ctx) {
    return {
      prompt: ctx.message.text,
      systemPromptExtra: `## Time Tracking (Clockify)
You have access to \`clockify_report\` tool for time tracking data. ALWAYS call it for real data — never guess hours.

**Tool:** \`clockify_report(report_type, period, group_by?, project_name?, user_name?)\`

**report_type options:**
- \`summary\` — breakdown of hours per person (with projects) or per project (with people)
- \`who_tracked\` — all active users sorted by tracked hours
- \`who_missing\` — active users with zero hours in period

**Examples:**
- "Выгрузка за март" → clockify_report(report_type="summary", period="last_month")
- "Кто не трекал на этой неделе?" → clockify_report(report_type="who_missing", period="this_week")
- "Сколько часов по STT?" → clockify_report(report_type="summary", period="this_month", project_name="Star Trek")
- "Что делал Никита?" → clockify_report(report_type="summary", period="last_week", user_name="Никита")
- "Часы по проектам" → clockify_report(report_type="summary", period="this_month", group_by="project")

**Formatting:** Use markdown table for multi-row results. Hours are already formatted as "42h 30m".`,
    }
  },
}

export default clockifySkill
