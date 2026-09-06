import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 유권자 앱(5173)과 분리된 별도 앱이다. 운영에서는 다른 호스트에 배포하고
// 선관위 사무실 IP 만 접근할 수 있게 막는다.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { '/api': 'http://localhost:4000' },
  },
});
