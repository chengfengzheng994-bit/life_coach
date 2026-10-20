'use strict';

/**
 * ============================================================================
 * AI 人生教练 · Vercel Serverless 接口 (api/chat.js)
 * ----------------------------------------------------------------------------
 * Vercel 会把本文件映射为 POST /api/chat。
 * 具体对话逻辑复用 lib/chat.js，与本地 server.js 完全一致。
 *
 * 所需环境变量（Vercel 项目 Settings → Environment Variables）：
 *   ARK_API_KEY   必填
 *   ARK_MODEL     可选
 *   ARK_API_URL   可选
 * ============================================================================
 */

const { handleChat } = require('../lib/chat');

module.exports = async function handler(req, res) {
  // 只接受 POST，其余方法直接拒绝
  if (req.method !== 'POST') {
    res.writeHead(405, {
      'Content-Type': 'application/json; charset=utf-8',
      'Allow': 'POST'
    });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  // 复用公共逻辑：读取对话、调用火山方舟、以 SSE 流式返回
  await handleChat(req, res);
};
