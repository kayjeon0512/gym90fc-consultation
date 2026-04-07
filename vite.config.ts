import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  // 설정 파일이 있는 폴더 기준으로 .env 로드 (터미널 cwd가 달라도 동일)
  const fileEnv = loadEnv(mode, projectRoot, '');
  // CI(GitHub Actions)는 환경 변수로 주입. 로컬은 process → .env
  const geminiKey =
    (process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '').trim() ||
    (fileEnv.GEMINI_API_KEY || fileEnv.VITE_GEMINI_API_KEY || '').trim();
  return {
    envDir: projectRoot,
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(geminiKey),
    },
    resolve: {
      alias: {
        '@': projectRoot,
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify — file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
