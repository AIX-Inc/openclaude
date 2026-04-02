import { type ChildProcess, spawn } from 'child_process'
import { createInterface } from 'readline'
import type { ServerLogger } from '../serverLog.js'

/**
 * Callback for NDJSON lines emitted by the child CLI process.
 * Each line is a raw JSON string (SDKMessage, control_request, etc.).
 */
export type OnMessage = (line: string) => void

/**
 * Callback when the child process exits.
 */
export type OnClose = (code: number | null, signal: string | null) => void

/**
 * Handle to a running CLI subprocess.
 */
export type SubprocessHandle = {
  /** Write an NDJSON line to the child's stdin. */
  writeStdin(data: string): void
  /** Send SIGTERM to the child. */
  kill(): void
  /** Send SIGKILL to the child. */
  forceKill(): void
  /** The child process (for PID access, etc.). */
  process: ChildProcess
  /** Promise that resolves when the child exits. */
  done: Promise<{ code: number | null; signal: string | null }>
}

/**
 * DangerousBackend spawns claude CLI subprocesses in --print mode.
 *
 * Each subprocess runs with:
 *   --print --input-format stream-json --output-format stream-json
 *
 * Communication is NDJSON over stdin/stdout.
 *
 * "Dangerous" because it uses dangerously_skip_permissions — the server
 * operator is responsible for tool whitelisting at the session level.
 */
export class DangerousBackend {
  private execPath: string
  private scriptArgs: string[]

  constructor() {
    this.execPath = process.execPath
    // If running via node/bun with a script, include the script path.
    // For compiled binaries, process.argv[1] is the binary itself.
    this.scriptArgs =
      process.argv[1] && process.argv[1] !== process.execPath
        ? [process.argv[1]]
        : []
  }

  /**
   * Spawn a new CLI subprocess for a session.
   */
  spawn(opts: {
    sessionId: string
    cwd: string
    env?: Record<string, string>
    onMessage: OnMessage
    onClose: OnClose
    logger?: ServerLogger
  }): SubprocessHandle {
    const args = [
      ...this.scriptArgs,
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ]

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...opts.env,
      // Mark as server-spawned session
      CLAUDE_CODE_ENVIRONMENT_KIND: 'server',
    }

    opts.logger?.debug(
      `Spawning session=${opts.sessionId} cwd=${opts.cwd} args=[${args.join(' ')}]`,
    )

    const child = spawn(this.execPath, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    })

    opts.logger?.debug(`session=${opts.sessionId} pid=${child.pid}`)

    // Parse NDJSON from stdout
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout })
      rl.on('line', (line) => {
        opts.onMessage(line)
      })
    }

    // Log stderr
    if (child.stderr) {
      const rl = createInterface({ input: child.stderr })
      rl.on('line', (line) => {
        opts.logger?.debug(`session=${opts.sessionId} stderr: ${line}`)
      })
    }

    const done = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) => {
        child.on('close', (code, signal) => {
          opts.logger?.debug(
            `session=${opts.sessionId} exited code=${code} signal=${signal}`,
          )
          opts.onClose(code, signal)
          resolve({ code, signal })
        })

        child.on('error', (err) => {
          opts.logger?.error(
            `session=${opts.sessionId} spawn error: ${err.message}`,
          )
          opts.onClose(1, null)
          resolve({ code: 1, signal: null })
        })
      },
    )

    let sigkillSent = false

    return {
      writeStdin(data: string) {
        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.write(data)
        }
      },
      kill() {
        if (!child.killed) {
          if (process.platform === 'win32') {
            child.kill()
          } else {
            child.kill('SIGTERM')
          }
        }
      },
      forceKill() {
        if (!sigkillSent && child.pid) {
          sigkillSent = true
          if (process.platform === 'win32') {
            child.kill()
          } else {
            child.kill('SIGKILL')
          }
        }
      },
      process: child,
      done,
    }
  }
}
