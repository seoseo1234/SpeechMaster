import { defineConfig, loadEnv } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 개발 서버에서 /api/* 요청을 api/ 폴더의 Vercel 함수로 연결 (배포 환경과 동일하게 동작)
function localApi(env) {
  return {
    name: 'local-api',
    configureServer(server) {
      for (const [key, value] of Object.entries(env)) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
      server.middlewares.use('/api', async (req, res, next) => {
        const name = new URL(req.url, 'http://localhost').pathname.replace(/^\/+|\/+$/g, '');
        const file = resolve(__dirname, 'api', `${name}.js`);
        if (!name || name.startsWith('_') || name.includes('/') || !existsSync(file)) return next();
        try {
          const mod = await server.ssrLoadModule(file);
          await mod.default(req, res);
        } catch (err) {
          next(err);
        }
      });
    }
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [localApi(env)],
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
    }
  };
});
