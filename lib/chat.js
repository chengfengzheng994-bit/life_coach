'use strict';

/**
 * ============================================================================
 * AI 人生教练 · 对话核心逻辑 (lib/chat.js)
 * ----------------------------------------------------------------------------
 * 作用：
 *   把「调用火山方舟 + 解析 SSE + 转发给前端」的逻辑抽成公共模块，
 *   让本地 Node 服务（server.js）与 Vercel Serverless 函数（api/chat.js）
 *   共用同一份实现，避免两处代码不一致。
 *
 * 环境变量（本地与 Vercel 通用）：
 *   ARK_API_KEY   必填，火山方舟 API Key
 *   ARK_MODEL     可选，模型名称
 *   ARK_API_URL   可选，接口地址
 * ============================================================================
 */

/* ---------------------------------------------------------------------------
 * 一、全局配置（全部来自环境变量，代码中不保存任何密钥）
 * ------------------------------------------------------------------------- */
const CONFIG = {
  // 服务端口，本地运行时可覆盖；Vercel 会自动注入 PORT
  PORT: Number(process.env.PORT) || 3000,

  // 火山方舟 responses 接口地址（非密钥，允许通过环境变量覆盖）
  ARK_API_URL: process.env.ARK_API_URL || 'https://ark.cn-beijing.volces.com/api/v3/responses',

  // API Key：只从环境变量读取
  ARK_API_KEY: process.env.ARK_API_KEY || '',

  // 使用的模型名称
  ARK_MODEL: process.env.ARK_MODEL || 'deepseek-v4-1-flash-260910',

  // 温度：0.6，兼顾稳定与创造力
  TEMPERATURE: 0.6,

  // 单次请求超时：55 秒（略小于 Vercel 函数 60 秒上限，避免被平台强制中断）
  REQUEST_TIMEOUT: Number(process.env.REQUEST_TIMEOUT) || 55000
};

/* ---------------------------------------------------------------------------
 * 二、人设设定（System Prompt）
 * ------------------------------------------------------------------------- */
const SYSTEM_PROMPT = `你是一位温暖、专业、富有洞察力的「AI 人生教练」(Life Coach)。你的使命是通过与用户对话，帮助他们认识自我、明确目标、克服困难，从而获得持续的成长。

请始终遵循以下原则：
1. 倾听与共情：先理解用户的处境与情绪，给予真诚的回应和肯定，不要说教。
2. 提问引导：多用开放式问题启发用户自己思考（例如"你理想中的状态是什么样的？"），而不是直接给答案。
3. 具体可行：给出的建议要具体、可执行、分步骤，避免空泛的大道理。
4. 积极而不盲目：在鼓励用户的同时，也客观指出可能遇到的挑战与风险。
5. 结构清晰：适当使用小标题、要点列表来组织回答，方便阅读。
6. 延续对话：记住此前聊过的内容，在合适的地方自然呼应。
7. 安全边界：你不是心理医生。如果用户提到严重的心理危机或自伤倾向，请温和而认真地建议其尽快寻求专业帮助或拨打心理援助热线。

请始终使用简体中文，语气亲切自然，像一位值得信赖的朋友兼导师。回答长度适中，重点突出，避免长篇大论。`;

/* ---------------------------------------------------------------------------
 * 三、工具函数
 * ------------------------------------------------------------------------- */

/**
 * 返回一个 SSE（Server-Sent Events）数据块字符串
 */
function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 读取请求体（原生 Node 流），返回 Promise<string>
 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * 兼容读取 JSON 请求体：
 *   - 本地 Node：从原始流读取
 *   - Vercel：body 可能已被平台解析到 req.body
 */
async function readJsonBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return req.body;
    if (Buffer.isBuffer(req.body)) return req.body.toString('utf-8');
    return JSON.stringify(req.body);
  }
  return readRequestBody(req);
}

/**
 * 把火山方舟的原始事件，转换成前端需要的简洁事件
 */
function transformEvent(evt) {
  const type = evt && evt.type;
  if (!type) return null;

  // 正文增量
  if (type === 'response.output_text.delta') {
    return sse('delta', { text: evt.delta || '' });
  }

  // 思考过程增量（DeepSeek 的推理摘要）
  if (type === 'response.reasoning_summary_text.delta') {
    return sse('reasoning', { text: evt.delta || '' });
  }

  // 触发联网搜索
  if (typeof type === 'string' && type.startsWith('response.web_search_call')) {
    return sse('tool', { name: 'web_search' });
  }

  // 整体完成
  if (type === 'response.completed') {
    return sse('done', {});
  }

  // 各类错误
  if (type === 'response.failed' || type === 'error' || type === 'response.error') {
    const message =
      (evt.response && evt.response.error && evt.response.error.message) ||
      (evt.error && evt.error.message) ||
      evt.message ||
      '模型返回了一个错误';
    return sse('error', { message: String(message) });
  }

  return null;
}

/* ---------------------------------------------------------------------------
 * 四、核心：处理 /api/chat 对话请求
 *   req / res 使用 Node 原生接口，本地服务与 Vercel 均可直接复用。
 * ------------------------------------------------------------------------- */
async function handleChat(req, res) {
  // 0. 未配置密钥时直接返回明确错误，避免带着空 Key 去请求上游
  if (!CONFIG.ARK_API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: '服务端未配置 ARK_API_KEY 环境变量，请先在本地或 Vercel 中设置后重试'
    }));
    return;
  }

  // 1. 读取前端传来的对话历史
  let payload;
  try {
    const raw = await readJsonBody(req);
    payload = JSON.parse(raw || '{}');
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '请求体不是合法的 JSON' }));
    return;
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];

  // 2. 把前端格式的消息，转换成火山方舟 responses 接口要求的 input 数组
  //    注意：多轮对话时每一项都必须带 type: 'message'，否则接口会返回
  //    400 MissingParameter: input.type
  const input = messages
    .filter((m) => m && typeof m.text === 'string' && m.text.trim() !== '')
    .map((m) => {
      const isAssistant = m.role === 'assistant';
      return {
        type: 'message',
        role: isAssistant ? 'assistant' : 'user',
        content: [
          { type: isAssistant ? 'output_text' : 'input_text', text: m.text }
        ]
      };
    });

  if (input.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '对话内容为空' }));
    return;
  }

  // 3. 先设置好 SSE 响应头，之后即可持续向前端推送数据
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    // 关闭 Nginx 等反向代理的缓冲，保证流式实时性
    'X-Accel-Buffering': 'no'
  });
  // Vercel / 部分运行时需要显式刷新响应头，才能立即开始流式输出
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // 4. 通过 AbortController 实现超时控制
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
  // 若前端主动中断（关闭页面 / 点击停止），也取消对上游的请求。
  // 注意：必须监听 res 的 close（客户端断开连接），不能监听 req——
  // 在 Node 中 req 的 close 会在请求体读完后立即触发，会误伤上游请求。
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    // 5. 调用火山方舟接口（开启流式输出）
    const arkRes = await fetch(CONFIG.ARK_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.ARK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: CONFIG.ARK_MODEL,
        stream: true,
        temperature: CONFIG.TEMPERATURE,
        instructions: SYSTEM_PROMPT,
        tools: [{ type: 'web_search', max_keyword: 3 }],
        input: input
      }),
      signal: controller.signal
    });

    // 上游返回非 200，读取错误信息并推送给前端
    if (!arkRes.ok) {
      const errText = await arkRes.text().catch(() => '');
      res.write(sse('error', {
        message: `上游接口返回 ${arkRes.status}：${errText.slice(0, 500)}`
      }));
      res.end();
      return;
    }

    // 6. 边读取上游流，边解析并转发给前端
    const reader = arkRes.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE 以换行分隔，逐行处理
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);

        // 只关心 data: 开头的行，内容是一条 JSON
        if (!line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr || dataStr === '[DONE]') continue;

        let evt;
        try {
          evt = JSON.parse(dataStr);
        } catch (e) {
          continue; // 忽略无法解析的行
        }

        const out = transformEvent(evt);
        if (out) res.write(out);
      }
    }

    // 7. 正常结束
    res.write(sse('done', {}));
    res.end();
  } catch (err) {
    // 超时或网络异常
    const isAbort = err && (err.name === 'AbortError');
    const seconds = Math.round(CONFIG.REQUEST_TIMEOUT / 1000);
    const msg = isAbort
      ? `请求超时（超过 ${seconds} 秒）或已被中断，请重试。`
      : `请求失败：${(err && err.message) || err}`;
    try {
      res.write(sse('error', { message: msg }));
      res.end();
    } catch (e) {
      /* 连接可能已关闭，忽略 */
    }
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  CONFIG,
  SYSTEM_PROMPT,
  handleChat,
  transformEvent
};
