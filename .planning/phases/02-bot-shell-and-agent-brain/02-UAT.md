---
status: complete
phase: 02-bot-shell-and-agent-brain
source: [02-01-SUMMARY.md, 02-02-SUMMARY.md, 02-03-SUMMARY.md, 02-04-SUMMARY.md, 02-05-SUMMARY.md]
started: 2026-02-25T09:15:00Z
updated: 2026-02-25T14:30:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Telegram — базовый ответ
expected: Отправь боту любое сообщение в Telegram. Бот должен ответить осмысленно, от лица Астры.
result: pass

### 2. Telegram — определение языка
expected: Напиши боту на русском — ответ должен быть на русском. Напиши на английском — ответ на английском. Язык переключается автоматически, без команд.
result: pass

### 3. Telegram — память в разговоре
expected: Напиши "меня зовут Дарий", потом в следующем сообщении спроси "как меня зовут?". Бот должен ответить "Дарий" — он помнит контекст разговора.
result: pass

### 4. Slack — базовый ответ
expected: Найди Астру в Slack (Apps → Astra), напиши ей в DM. Бот должен ответить осмысленно, от лица Астры.
result: pass
note: Ответ пришёл в тред — ок. Фикс: включить Messages Tab в App Home settings.

### 5. Slack — только твои сообщения
expected: Если другой человек напишет боту в Slack — бот его молча игнорирует (не отвечает). Проверить можно с другого аккаунта или просто убедиться что бот стартовал с твоим SLACK_ADMIN_USER_ID.
result: pass

### 6. Команда /settings
expected: Напиши боту /settings в Telegram. Бот должен показать текущие настройки уведомлений с иконками: 5 категорий (tasks, emails, meetings, alerts, digest) с их каналами и уровнями срочности.
result: pass

### 7. Настройка предпочтений через текст
expected: Напиши "присылай мне только срочные уведомления". Бот должен подтвердить что настройка изменена, без команд — просто из текста.
result: pass

## Summary

total: 7
passed: 7
issues: 0
pending: 0
skipped: 0

## Gaps

[none]
