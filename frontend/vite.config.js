import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // REST calls like /cluster-status get forwarded to gateway
      '/cluster-status': {
        target: 'http://gateway:8080',
        changeOrigin: true,
      },
      // WebSocket connections get forwarded to gateway
      '/socket.io': {
        target: 'http://gateway:8080',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})