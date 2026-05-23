import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface PushSubscription {
  endpoint: string
  expirationTime: number | null
  keys: { p256dh: string, auth: string }
  createdAt: number
  ua?: string
}

export class SubscriptionStore {
  private filepath: string
  private subs = new Map<string, PushSubscription>()
  private flushTimer: NodeJS.Timeout | null = null

  constructor (dataDir: string) {
    this.filepath = path.resolve(dataDir, 'push-subscriptions.json')
  }

  async load (): Promise<void> {
    try {
      const raw = await fs.readFile(this.filepath, 'utf-8')
      const arr: PushSubscription[] = JSON.parse(raw)
      this.subs.clear()
      for (const s of arr) this.subs.set(s.endpoint, s)
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err
      await fs.mkdir(path.dirname(this.filepath), { recursive: true })
    }
  }

  list (): PushSubscription[] {
    return Array.from(this.subs.values())
  }

  has (endpoint: string): boolean {
    return this.subs.has(endpoint)
  }

  add (sub: Omit<PushSubscription, 'createdAt'> & { createdAt?: number }): PushSubscription {
    const full: PushSubscription = { ...sub, createdAt: sub.createdAt ?? Date.now() }
    this.subs.set(full.endpoint, full)
    this.scheduleFlush()
    return full
  }

  remove (endpoint: string): boolean {
    const ok = this.subs.delete(endpoint)
    if (ok) this.scheduleFlush()
    return ok
  }

  private scheduleFlush () {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush().catch(() => { /* swallow */ })
    }, 250)
  }

  private async flush () {
    const data = JSON.stringify(Array.from(this.subs.values()), null, 2)
    await fs.mkdir(path.dirname(this.filepath), { recursive: true })
    await fs.writeFile(this.filepath, data)
  }
}
