import webpush from 'web-push'
import { SubscriptionStore } from '../store/subscriptions.js'

export interface PushPayload {
  title: string
  body: string
  tag?: string
  url?: string
  data?: Record<string, unknown>
}

export class PushNotifier {
  constructor (
    private store: SubscriptionStore,
    private vapid: { publicKey: string, privateKey: string, subject: string },
  ) {
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey)
  }

  async sendToAll (payload: PushPayload): Promise<{ sent: number, removed: number }> {
    const subs = this.store.list()
    let sent = 0
    let removed = 0
    await Promise.all(subs.map(async sub => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify(payload),
          { TTL: 60 * 60 * 24 },
        )
        sent++
      } catch (err: any) {
        const status = err?.statusCode ?? err?.status
        if (status === 404 || status === 410) {
          this.store.remove(sub.endpoint)
          removed++
        }
      }
    }))
    return { sent, removed }
  }
}
