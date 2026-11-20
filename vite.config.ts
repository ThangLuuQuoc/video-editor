import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_PORT = Number(process.env.AI_VIDEO_PORT || 8787);

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      '/api': `http://localhost:${API_PORT}`,
      '/media': `http://localhost:${API_PORT}`
    }
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true
  }
});
