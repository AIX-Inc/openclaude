import { randomUUID } from 'crypto'
import type { DangerousBackend, SubprocessHandle } from './backends/dangerousBackend.js'
import type { SessionInfo, SessionState } from './types.js'
import type { ServerLogger } from './serverLog.js'

export type SessionManagerOpts = {
  idleTimeoutMs: number
  maxSessions: number
}

type ManagedSession = SessionInfo & {
  handle: SubprocessHandle
  /** Callback for NDJSON lines from this session's subprocess. */
  onMessage?: (line: string) => void
  /** Timer for idle timeout. */
  idleTimer?: ReturnType<typeof setTimeout>
}

/**
 * SessionManager owns the lifecycle of all server sessions.
 *
 * Responsibilities:
 * - Create/destroy sessions
 * - Enforce max concurrent sessions
 * - Idle timeout
 * - Session reaper (auto-cleanup on subprocess crash)
 */
export class SessionManager {
  private sessions = new Map<string, ManagedSession>()
  private backend: DangerousBackend
  private opts: SessionManagerOpts
  private logger?: ServerLogger

  constructor(
    backend: DangerousBackend,
    opts: SessionManagerOpts,
    logger?: ServerLogger,
  ) {
    this.backend = backend
    this.opts = opts
    this.logger = logger
  }

  setLogger(logger: ServerLogger) {
    this.logger = logger
  }

  /**
   * Create a new session.
   * Returns the session info including the generated session ID.
   * Throws if max sessions reached.
   */
  create(opts: {
    cwd: string
    env?: Record<string, string>
    allowedTools?: string[]
    disallowedTools?: string[]
    onMessage: (sessionId: string, line: string) => void
  }): SessionInfo {
    if (
      this.opts.maxSessions > 0 &&
      this.sessions.size >= this.opts.maxSessions
    ) {
      throw new MaxSessionsError(this.opts.maxSessions)
    }

    const sessionId = randomUUID()
    const now = Date.now()

    const handle = this.backend.spawn({
      sessionId,
      cwd: opts.cwd,
      env: opts.env,
      allowedTools: opts.allowedTools,
      disallowedTools: opts.disallowedTools,
      onMessage: (line) => {
        // Reset idle timer on activity
        this.resetIdleTimer(sessionId)
        opts.onMessage(sessionId, line)
      },
      onClose: (_code, _signal) => {
        // Session reaper: auto-cleanup when subprocess exits
        this.logger?.info(`Session ${sessionId} subprocess exited, cleaning up`)
        this.cleanup(sessionId)
      },
      logger: this.logger,
    })

    const session: ManagedSession = {
      id: sessionId,
      status: 'running',
      createdAt: now,
      workDir: opts.cwd,
      process: handle.process,
      handle,
    }

    this.sessions.set(sessionId, session)
    this.resetIdleTimer(sessionId)

    this.logger?.info(
      `Session created: ${sessionId} (${this.sessions.size}/${this.opts.maxSessions} slots)`,
    )

    return {
      id: session.id,
      status: session.status,
      createdAt: session.createdAt,
      workDir: session.workDir,
      process: session.process,
    }
  }

  /**
   * Get a session by ID.
   */
  get(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Check if a session exists.
   */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /**
   * Write data to a session's subprocess stdin.
   */
  writeToSession(sessionId: string, data: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.handle.writeStdin(data)
    this.resetIdleTimer(sessionId)
    return true
  }

  /**
   * Destroy a single session. Sends SIGTERM, waits briefly, then SIGKILL.
   */
  async destroy(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    this.logger?.info(`Destroying session: ${sessionId}`)
    session.status = 'stopping'
    this.clearIdleTimer(sessionId)

    session.handle.kill()

    // Give 5s for graceful exit, then force kill
    const timeout = setTimeout(() => {
      session.handle.forceKill()
    }, 5000)

    await session.handle.done
    clearTimeout(timeout)

    this.cleanup(sessionId)
  }

  /**
   * Destroy all sessions. Used during graceful shutdown.
   */
  async destroyAll(): Promise<void> {
    const promises = Array.from(this.sessions.keys()).map((id) =>
      this.destroy(id),
    )
    await Promise.allSettled(promises)
  }

  /**
   * Get count of active sessions.
   */
  get size(): number {
    return this.sessions.size
  }

  // --- Internal ---

  private cleanup(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.clearIdleTimer(sessionId)
    session.status = 'stopped'
    this.sessions.delete(sessionId)
    this.logger?.debug(
      `Session cleaned up: ${sessionId} (${this.sessions.size} remaining)`,
    )
  }

  private resetIdleTimer(sessionId: string) {
    if (this.opts.idleTimeoutMs <= 0) return

    this.clearIdleTimer(sessionId)
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.idleTimer = setTimeout(() => {
      this.logger?.info(
        `Session ${sessionId} idle timeout (${this.opts.idleTimeoutMs}ms), destroying`,
      )
      void this.destroy(sessionId)
    }, this.opts.idleTimeoutMs)
  }

  private clearIdleTimer(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (session?.idleTimer) {
      clearTimeout(session.idleTimer)
      session.idleTimer = undefined
    }
  }
}

export class MaxSessionsError extends Error {
  constructor(max: number) {
    super(`Maximum concurrent sessions reached (${max})`)
    this.name = 'MaxSessionsError'
  }
}
