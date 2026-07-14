import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const invokeUrl = env.VITE_CLOVA_INVOKE_URL || 'https://clovaspeech-gw.ncloud.com';
  let targetOrigin = 'https://clovaspeech-gw.ncloud.com';
  try {
    targetOrigin = new URL(invokeUrl).origin;
  } catch(e) {}

  return {
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
