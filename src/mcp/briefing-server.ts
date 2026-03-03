#!/usr/bin/env node
/**
 * Astra Briefing MCP Server — entry point.
 *
 * All logic lives in ./briefing/ modules. This file exists as the stable
 * entry point referenced by config-generator.ts.
 */
import { main } from './briefing/server.js'

main().catch((error) => {
  process.stderr.write(`Fatal: ${error}\n`)
  process.exit(1)
})
