import { Bot } from 'grammy'
import { env } from '../config/env.js'

const bot = new Bot(env.TELEGRAM_BOT_TOKEN)

bot.command('start', (ctx) => ctx.reply('Astra is running'))

bot.catch((err) => {
  const ctx = err.ctx
  console.error(`Error while handling update ${ctx.update.update_id}:`)
  console.error(err.error)
})

function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down bot...`)
  bot.stop()
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

console.log('Bot started')
bot.start()
