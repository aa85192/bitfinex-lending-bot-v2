import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'export',
  basePath: '/bitfinex-lending-bot-v2',
  trailingSlash: true,
  images: { unoptimized: true },
}

export default nextConfig
