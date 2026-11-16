import { spawn } from 'node:child_process';
import { createArenaApp } from './app.mjs';

let app = null;
let shuttingDown = false;

function openBrowser(url) {
  if (process.env.ARENA_OPEN_BROWSER !== '1' || process.env.ARENA_NO_BROWSER === '1') return;
  setTimeout(() => {
    try {
      const command = process.platform === 'win32'
        ? 'explorer.exe'
        : process.platform === 'darwin'
          ? 'open'
          : 'xdg-open';
      const child = spawn(command, [url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', () => {});
      child.unref();
    } catch {
      // 自动打开失败不阻止服务启动；终端里仍有可点击/复制的地址。
    }
  }, 650).unref();
}

async function main() {
  app = await createArenaApp({
    configPath: process.env.ARENA_CONFIG,
    logger: {
      info: (message) => console.log(`[arena] ${message}`),
      warn: (message) => console.warn(`[arena] ${message}`),
      error: (message) => console.error(`[arena] ${message}`),
    },
  });
  const { url } = await app.start();
  console.log('');
  console.log('  AI 桌游竞技场已就绪');
  console.log(`  本机网页：${url}`);
  console.log(`  数据目录：${app.configStore.matchDir}`);
  console.log(`  配置文件：${app.configStore.configPath}`);
  console.log('  按 Ctrl+C 停止服务');
  console.log('');
  openBrowser(url);
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[arena] 收到 ${signal}，正在关闭…`);
  try {
    await app?.close();
  } catch (error) {
    console.error(`[arena] 关闭时出错：${error.message}`);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch(async (error) => {
  console.error(`[arena] 启动失败：${error.message}`);
  if (error?.code === 'EADDRINUSE') {
    console.error('[arena] 端口已被占用，请修改 data/arena.json 的 server.port 或关闭占用的程序。');
  }
  try {
    await app?.close();
  } catch {
    // 忽略关闭时的次生错误。
  }
  process.exit(1);
});
