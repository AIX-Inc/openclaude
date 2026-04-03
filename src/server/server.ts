import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ServerConfig } from './types.js'
import { SessionManager, MaxSessionsError } from './sessionManager.js'
import type { ServerLogger } from './serverLog.js'

/**
 * Start the OpenClaude Server using Node's http + ws.
 *
 * Exposes:
 * - POST /sessions — create a new session, returns { session_id, ws_url }
 * - GET /health — liveness check (no auth)
 * - WebSocket /ws/:sessionId — NDJSON streaming (upgrade via GET)
 *
 * All endpoints (except /health) require Bearer token auth.
 */
export function startServer(
  config: ServerConfig,
  sessionManager: SessionManager,
  logger: ServerLogger,
): { port: number; stop(force?: boolean): void } {
  sessionManager.setLogger(logger)

  // Track WebSocket connections per session for message routing
  const wsConnections = new Map<string, Set<WebSocket>>()

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname
    const method = req.method ?? 'GET'

    // Health check (no auth)
    if (path === '/health' && method === 'GET') {
      sendJson(res, 200, { status: 'ok', sessions: sessionManager.size })
      return
    }

    // Auth check for all other endpoints
    const authHeader = req.headers.authorization
    if (authHeader !== `Bearer ${config.authToken}`) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }

    // POST /sessions — create session
    if (path === '/sessions' && method === 'POST') {
      await handleCreateSession(req, res, config, sessionManager, logger, wsConnections, actualPort)
      return
    }

    sendJson(res, 404, { error: 'Not Found' })
  })

  // WebSocket server attached to the HTTP server
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname

    // Auth check
    const authHeader = req.headers.authorization
    if (authHeader !== `Bearer ${config.authToken}`) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    // Match /ws/:sessionId
    const wsMatch = path.match(/^\/ws\/([^/]+)$/)
    if (!wsMatch) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    const sessionId = wsMatch[1]!
    if (!sessionManager.has(sessionId)) {
      socket.write('HTTP/1.1 404 Session Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      logger.info(`WebSocket connected: session=${sessionId}`)

      if (!wsConnections.has(sessionId)) {
        wsConnections.set(sessionId, new Set())
      }
      wsConnections.get(sessionId)!.add(ws)

      ws.on('message', (message: Buffer | string) => {
        const data = typeof message === 'string' ? message : message.toString()
        const written = sessionManager.writeToSession(sessionId, data + '\n')
        if (!written) {
          logger.error(`Failed to write to session ${sessionId} (not found)`)
          ws.close(1011, 'Session not found')
        }
      })

      ws.on('close', (code: number, reason: Buffer) => {
        logger.info(
          `WebSocket disconnected: session=${sessionId} code=${code} reason=${reason.toString()}`,
        )
        const connections = wsConnections.get(sessionId)
        if (connections) {
          connections.delete(ws)
          if (connections.size === 0) {
            wsConnections.delete(sessionId)
          }
        }
      })
    })
  })

  // Listen
  let actualPort = config.port
  httpServer.listen(config.port, config.host, () => {
    const addr = httpServer.address()
    if (addr && typeof addr === 'object') {
      actualPort = addr.port
    }
    logger.info(`Server started on ${config.host}:${actualPort}`)
  })

  return {
    get port() {
      return actualPort
    },
    stop(force?: boolean) {
      // Close all WebSocket connections
      for (const [, connections] of wsConnections) {
        for (const ws of connections) {
          ws.close(1001, 'Server shutting down')
        }
      }
      wsConnections.clear()

      if (force) {
        httpServer.closeAllConnections()
      }
      httpServer.close()
    },
  }
}

// --- Helpers ---

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

async function handleCreateSession(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  sessionManager: SessionManager,
  logger: ServerLogger,
  wsConnections: Map<string, Set<WebSocket>>,
  serverPort: number,
) {
  let body: {
    cwd?: string
    env?: Record<string, string>
    allowedTools?: string[]
    disallowedTools?: string[]
  }
  try {
    const raw = await readBody(req)
    body = JSON.parse(raw)
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' })
    return
  }

  const cwd = body.cwd ?? config.workspace ?? process.cwd()

  try {
    const session = sessionManager.create({
      cwd,
      env: body.env,
      allowedTools: body.allowedTools,
      disallowedTools: body.disallowedTools,
      onMessage: (sessionId, line) => {
        // Route subprocess NDJSON output to all connected WebSocket clients
        const connections = wsConnections.get(sessionId)
        if (connections) {
          for (const ws of connections) {
            try {
              ws.send(line + '\n')
            } catch {
              // WebSocket might have closed
            }
          }
        }
      },
    })

    const wsUrl = config.unix
      ? `ws+unix://${config.unix}/ws/${session.id}`
      : `ws://${config.host}:${serverPort}/ws/${session.id}`

    logger.info(`Session created: ${session.id} cwd=${cwd}`)

    sendJson(res, 201, {
      session_id: session.id,
      ws_url: wsUrl,
      work_dir: cwd,
    })
  } catch (err) {
    if (err instanceof MaxSessionsError) {
      sendJson(res, 503, { error: err.message })
      return
    }
    logger.error(`Failed to create session: ${(err as Error).message}`)
    sendJson(res, 500, { error: 'Internal server error' })
  }
}
