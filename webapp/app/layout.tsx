import type { Metadata } from 'next'
import './globals.css'
import Nav from '@/components/Nav'

export const metadata: Metadata = {
  title: 'WTK的放貸管理',
  description: 'Bitfinex 放貸收益管理儀表板',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-Hant">
      <body>
        <Nav />
        <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {children}
        </main>
        <footer className="border-t border-gray-100 mt-16">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <p className="text-xs text-gray-400 text-center">資料每 60 秒自動更新</p>
          </div>
        </footer>
      </body>
    </html>
  )
}
