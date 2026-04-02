import { readFile, writeFile, unlink, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

export type ServerLockInfo = {
  pid: number
  port: number
  host: string
  httpUrl: string
  startedAt: number
}

const LOCK_PATH = join(homedir(), '.claude', 'server.lock')

export async function writeServerLock(info: ServerLockInfo): Promise<void> {
  // Ensure ~/.claude directory exists
  await mkdir(join(homedir(), '.claude'), { recursive: true })
  await writeFile(LOCK_PATH, JSON.stringify(info, null, 2), 'utf-8')
}

export async function removeServerLock(): Promise<void> {
  try {
    await unlink(LOCK_PATH)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
  }
}

export async function probeRunningServer(): Promise<ServerLockInfo | null> {
  let raw: string
  try {
    raw = await readFile(LOCK_PATH, 'utf-8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw err
  }

  const info: ServerLockInfo = JSON.parse(raw)

  try {
    process.kill(info.pid, 0)
  } catch {
    // Process is not running — stale lock file
    await removeServerLock()
    return null
  }

  return info
}
