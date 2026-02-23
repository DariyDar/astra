import '../config/env.js'

// Phase 1: audit trail cleanup job will be added in Plan 02

console.log('Worker started')

function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down worker...`)
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// Keep the worker process alive
setInterval(() => {
  // Heartbeat - worker is alive
}, 60_000)
