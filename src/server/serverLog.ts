export type ServerLogger = {
  info(msg: string): void
  error(msg: string): void
  debug(msg: string): void
}

export function createServerLogger(): ServerLogger {
  return {
    info(msg: string) {
      console.log(`[server] ${msg}`)
    },
    error(msg: string) {
      console.error(`[server:error] ${msg}`)
    },
    debug(msg: string) {
      if (process.env.DEBUG) {
        console.log(`[server:debug] ${msg}`)
      }
    },
  }
}
