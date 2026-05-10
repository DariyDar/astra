# Telegram channel — Astra

## Bot

- **Username:** `@AstraAssistant_bot`
- **Bot ID:** см. `~/personal-assistant/.env` (`TELEGRAM_BOT_TOKEN` first segment)
- **Используем тот же токен**, что и production astra-bot. Один токен — один long-poll consumer.

## Allowed users

- **Дарий:** chat_id = `87312202` (единственный allowed user в `TELEGRAM_ALLOWED_USERS`)
- Любые другие сообщения — silently dropped (это default behavior `module-auth` в angel-agent).

## Routing

```
@AstraAssistant_bot getUpdates
       │
       ▼
angel-agent astra-daemon (port 9241)
       │
       ├── if chat_id == 87312202 → JSONL inbox → MCP plugin → Claude Code session (tmux astra)
       └── else → silently drop, log "unauthorized chat: <id>"
```

## КРИТИЧНО: production astra-bot должен быть выключен от long-poll

Перед запуском astra-daemon Тёма должен убедиться:

```bash
pm2 status astra-bot
```

Если `online` — нужно либо:
1. **Остановить:** `pm2 stop astra-bot` (но тогда сломается `astra-worker` если они шарят инициализацию)
2. **Лучше — отключить long-poll в коде:** `~/personal-assistant/src/bot/index.ts` поменять `bot.start()` на `// bot.start()` и закоммитить через GitHub Actions (или Дарий сделает PR)

Иначе оба процесса будут конкурировать за `getUpdates` и сообщения будут теряться.

**`astra-worker` (PM2 id 67)** — НЕ трогать. Он запускает cron'ы (digest 01:00 UTC, pre-meeting вт 07:00 UTC, drive-tree пн/ср/пт 06:00 Bali) которые шлют ИСХОДЯЩИЕ через `bot.api.sendMessage`. Long-poll ему не нужен.

## Voice STT

Включён в `.env`:
```
STT_MODULE=whisper
WHISPER_MODEL=base
```

`module-stt` сам обрабатывает голосовые. Дарий часто шлёт голосовые на русском — `whisper base` ок для русского, но если качество низкое, поднять до `small`.

## Typing indicator + стикеры

Сейчас `TYPING_STICKERS=` пусто — будет дефолтный "typing..." индикатор.

Можем добавить кастомные стикеры (например, кот печатает) позже:
1. Найти sticker file_id через @AstraAssistant_bot (forward стикер боту, в логах daemon будет file_id)
2. Добавить в `.env`: `TYPING_STICKERS=CAACAgIAAxk...,CAACAgIAAxk...`

## Bot menu

```
MENU_COMMANDS=start:Привет;status:Статус;help:Что я умею
```

При желании можем добавить команды для частых действий: `digest`, `briefing`, `lisbon`, `cleanup`. Но это уже после первого работающего запуска.

## Reply protocol (для меня)

Все ответы пользователю — через MCP `reply`:
```
reply({ chat_id: "87312202", text: "..." })
```

Что НЕ работает (сообщение не дойдёт):
- `console.log` / `process.stdout.write` — это в логи daemon, не в Telegram
- `bot.sendMessage` — нет такого, у меня нет прямого доступа к grammY
- Любой другой канал

Если забыла вызвать `reply` — пользователь видит молчание и думает, что я сломалась.

## Edits для прогресс-апдейтов

Если делаю долгую задачу (поиск, генерация отчёта):
1. Первое сообщение через `reply` — "ищу X..."
2. Прогресс через `edit_message({ message_id, text })` — это НЕ триггерит push-уведомление
3. Финал через ещё один `reply` или последний `edit_message`

Так пользователь не получает 5 пуш-уведомлений на одну задачу.

## Reactions

Для коротких подтверждений вместо текста — `react`:
- 👍 на «понял задачу»
- 🤔 на «обдумываю»
- ✅ на «сделано»

Не злоупотребляем — текст всё равно читается лучше.
