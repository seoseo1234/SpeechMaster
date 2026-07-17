import { defineConfig, loadEnv } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const invokeUrl = env.VITE_CLOVA_INVOKE_URL || 'https://clovaspeech-gw.ncloud.com';
  let targetOrigin = 'https://clovaspeech-gw.ncloud.com';
  try {
    targetOrigin = new URL(invokeUrl).origin;
  } catch(e) {}

  return {
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          login: resolve(__dirname, 'login.html'),
          teacher: resolve(__dirname, 'teacher.html'),
          lowGrade: resolve(__dirname, 'low-grade.html'),
          highGrade: resolve(__dirname, 'high-grade.html'),
          about: resolve(__dirname, 'about.html'),
          faceTrackingDemo: resolve(__dirname, 'face_tracking_demo.html')
        }
      }
    },
    server: {
      proxy: {
        '/api/clova': {
          target: targetOrigin,
          changeOrigin: true,
          secure: false,
          rewrite: (path) => path.replace(/^\/api\/clova/, '')
        }
      }
    }
  };
});
