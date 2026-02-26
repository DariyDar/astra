/** @type {import('pm2').StartOptions[]} */
module.exports = {
  apps: [
    {
      name: 'astra-bot',
      cwd: '/home/clawdbot/personal-assistant',
      script: './node_modules/.bin/tsx',
      args: 'src/bot/index.ts',
      kill_timeout: 10000,
      restart_delay: 10000,
      max_restarts: 10,
      min_uptime: 5000,
      wait_ready: false,
      listen_timeout: 8000,
    },
    {
      name: 'astra-worker',
      cwd: '/home/clawdbot/personal-assistant',
      script: './node_modules/.bin/tsx',
      args: 'src/worker/index.ts',
      kill_timeout: 5000,
    },
  ],
}
