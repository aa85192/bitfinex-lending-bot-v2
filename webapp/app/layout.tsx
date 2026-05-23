import type { Metadata, Viewport } from 'next'
import './globals.css'
import Nav from '@/components/Nav'
import ServiceWorkerRegistrar from '@/components/ServiceWorkerRegistrar'

export const metadata: Metadata = {
  title: 'WTK的放貸管理',
  description: 'Bitfinex 放貸收益管理儀表板',
  manifest: './manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: '放貸管理',
    statusBarStyle: 'default',
  },
  icons: {
    icon: './icon.svg',
    apple: './icon.svg',
  },
}

export const viewport: Viewport = {
  themeColor: '#10b981',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout ({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-Hant">
      <body>
        <ServiceWorkerRegistrar />
        <Nav />
        <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {children}
        </main>
        <footer className="border-t border-gray-100 mt-16">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <p className="text-xs text-gray-400 text-center">即時資料由 GCP 端 Bot 透過 WebSocket 推播</p>
          </div>
        </footer>
      </body>
    </html>
  )
}
