'use strict';

/**
 * ============================================================================
 * AI 人生教练 · 本地服务器 (server.js)
 * ----------------------------------------------------------------------------
 * 作用：
 *   1. 托管前端静态页面（public 目录下的 index.html / styles.css / app.js）
 *   2. 把 /api/chat 请求交给 lib/chat.js 处理（与 Vercel 函数共用同一份逻辑）
 *
 * 说明：
 *   - 对话逻辑已抽到 lib/chat.js，本文件只负责本地静态托管与路由
 *   - 部署到 Vercel 时由 api/chat.js + 平台静态托管接管，不会运行本文件
 *   - 运行环境：Node.js 18 及以上（使用内置 fetch 与 Web Stream）
 *   - 启动：node server.js（本地密钥写在 .env 中，该文件不会被提交）
 * ============================================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// 本地开发：自动读取项目根目录的 .env（该文件已被 Git 忽略）；
// Vercel 上不存在该文件，直接使用平台注入的环境变量。
const ENV_FILE = path.join(__dirname, '.env');
if (typeof process.loadEnvFile === 'function' && fs.existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

const { CONFIG, handleChat } = require('./lib/chat');

/* ---------------------------------------------------------------------------
 * 一、静态资源相关工具
 * ------------------------------------------------------------------------- */
const PUBLIC_DIR = path.join(__dirname, 'public');

// 常见文件类型的 MIME 映射表，保证浏览器正确解析
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/**
 * 处理静态文件请求
 */
function serveStatic(req, res) {
  // 去掉查询字符串，默认访问 index.html
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  // 拼接真实路径，并做安全校验，防止目录穿越攻击
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

/* ---------------------------------------------------------------------------
 * 二、创建并启动 HTTP 服务
 * ------------------------------------------------------------------------- */
const server = http.createServer((req, res) => {
  // 聊天接口：交给公共模块处理
  if (req.method === 'POST' && req.url === '/api/chat') {
    handleChat(req, res);
    return;
  }
  // 其余 GET 请求都按静态资源处理
  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }
  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('405 Method Not Allowed');
});

server.listen(CONFIG.PORT, () => {
  console.log('==================================================');
  console.log('  AI 人生教练服务已启动');
  console.log(`  请在浏览器打开：http://localhost:${CONFIG.PORT}`);
  console.log(`  使用模型：${CONFIG.ARK_MODEL}`);
  if (!CONFIG.ARK_API_KEY) {
    console.log('  [警告] 未检测到环境变量 ARK_API_KEY，对话接口将不可用');
    console.log('  请在启动前设置：$env:ARK_API_KEY="你的密钥"');
  }
  console.log('  按 Ctrl + C 可停止服务');
  console.log('==================================================');
});
