export function parsePeriod(period?: string): { after: Date; before: Date } {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayEnd = new Date(todayStart.getTime() + 86400_000)

  if (!period || period === 'today') {
    return { after: todayStart, before: todayEnd }
  }
  if (period === 'yesterday') {
    const yStart = new Date(todayStart.getTime() - 86400_000)
    return { after: yStart, before: todayStart }
  }
  if (period === 'last_3_days') {
    return { after: new Date(todayStart.getTime() - 3 * 86400_000), before: todayEnd }
  }
  if (period === 'this_week') {
    const dayOfWeek = todayStart.getDay() || 7 // Sunday=7 (ISO week starts Monday)
    const monday = new Date(todayStart.getTime() - (dayOfWeek - 1) * 86400_000)
    return { after: monday, before: todayEnd }
  }
  if (period === 'last_week') {
    const dayOfWeek = todayStart.getDay() || 7
    const thisMonday = new Date(todayStart.getTime() - (dayOfWeek - 1) * 86400_000)
    const lastMonday = new Date(thisMonday.getTime() - 7 * 86400_000)
    return { after: lastMonday, before: thisMonday }
  }
  if (period === 'this_month') {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    return { after: monthStart, before: todayEnd }
  }
  if (period === 'last_month') {
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    return { after: lastMonthStart, before: thisMonthStart }
  }
  // ISO date range: "2026-01-01/2026-01-20"
  if (period.includes('/')) {
    const [from, to] = period.split('/')
    const after = new Date(from)
    const before = new Date(to)
    if (isNaN(after.getTime()) || isNaN(before.getTime())) {
      throw new Error(`Invalid date range: "${period}". Expected ISO format like "2026-01-01/2026-01-20"`)
    }
    return { after, before }
  }
  // Single date
  const d = new Date(period)
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date: "${period}". Use "today", "last_week", or ISO date like "2026-01-01"`)
  }
  return { after: d, before: new Date(d.getTime() + 86400_000) }
}

export function toSlackTs(date: Date): string {
  return (date.getTime() / 1000).toFixed(6)
}

export function toGmailDate(date: Date): string {
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`
}
