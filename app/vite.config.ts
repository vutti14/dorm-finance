import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'ระบบเงินหอพัก นารา–ปรายดาว',
        short_name: 'เงินหอพัก',
        lang: 'th',
        start_url: '/',
        display: 'standalone',
        background_color: '#F2F4F3',
        theme_color: '#12343B',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      workbox: { navigateFallback: '/index.html', globPatterns: ['**/*.{js,css,html,svg,woff2}'] },
    }),
  ],
  test: { environment: 'node', testTimeout: 30000 },
})
