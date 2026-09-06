import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000' },
    // 봉인 모듈은 packages/ballot-seal 에 있다 (브라우저·서버 공유 규격).
    fs: { allow: ['../..'] },
  },
});
