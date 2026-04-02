import type { ServerConfig } from './types.js'

export function printBanner(
  config: ServerConfig,
  authToken: string,
  actualPort: number,
): void {
  const url = config.unix
    ? `unix:${config.unix}`
    : `http://${config.host}:${actualPort}`
  console.log(`\nClaude Code Server listening on ${url}`)
  console.log(`Auth token: ${authToken}`)
  console.log(`Max sessions: ${config.maxSessions ?? 'unlimited'}`)
  console.log(`Idle timeout: ${config.idleTimeoutMs ?? 600000}ms\n`)
}
