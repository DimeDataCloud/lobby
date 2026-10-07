import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/events': 'http://localhost:4000',
      '/health': 'http://localhost:4000',
      '/lobbies': 'http://localhost:4000',
      '/presence': 'http://localhost:4000',
      '/annotations': 'http://localhost:4000',
      '/canvas': 'http://localhost:4000',
      '/agents': 'http://localhost:4000',
    }
  }
})