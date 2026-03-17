import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Kayou Chat',
  description: 'Your AI team chat — powered by Kayou',
  viewport: 'width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1',
  themeColor: '#3563C9',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Kayou Chat' },
  icons: { icon: '/kayou-logo.png', apple: '/kayou-logo.png' },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  )
}
