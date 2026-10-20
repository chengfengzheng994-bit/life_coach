'use strict';

/* ============================================================================
   AI 人生教练 · 前端逻辑 (app.js)
   ----------------------------------------------------------------------------
   主要职责：
     1. 维护对话状态（messages：包含用户与 AI 的历史，用于让 AI 记住上下文）
     2. 把用户输入发送给本地后端 /api/chat，并读取流式(SSE)返回
     3. 将返回内容实时渲染到界面上（支持简单的 Markdown 排版）
     4. 处理"停止生成""清空对话""自动滚动""输入框自适应高度"等交互
   ========================================================================== */

/* ---------------------------------------------------------------------------
   一、DOM 元素引用
   ------------------------------------------------------------------------- */
const chatArea = document.getElementById('chatArea');
const messagesEl = document.getElementById('messages');
const welcomeEl = document.getElementById('welcome');
const formEl = document.getElementById('composerForm');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const clearBtn = document.getElementById('clearBtn');

/* ---------------------------------------------------------------------------
   二、应用状态
   ------------------------------------------------------------------------- */
const state = {
  // 完整的对话历史：每项形如 { role: 角色, text: 文本 }
  messages: [],
  // 是否正在生成回答
  isGenerating: false,
  // 用于中断请求的控制器
  controller: null,
  // 本次生成的开始时间，用于忽略"连击"造成的误中止
  generationStartedAt: 0
};

/* ---------------------------------------------------------------------------
   三、Markdown 渲染
   说明：为了不依赖任何第三方库，这里实现一个轻量的 Markdown 转 HTML。
        仅支持常用语法：代码块、行内代码、标题、粗体、斜体、链接、
        有序/无序列表、引用、分割线、换行。转换前会先做 HTML 转义，防止 XSS。
   ------------------------------------------------------------------------- */

// 代码围栏 = 连续的三个反引号。用 repeat 生成，避免源码里出现连续三个反引号
const FENCE = '`'.repeat(3);
const CODE_BLOCK_RE = new RegExp(FENCE + '[^\\n]*\\n?([\\s\\S]*?)' + FENCE, 'g');

/** HTML 特殊字符转义，防止注入 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 将 Markdown 文本转换为安全的 HTML 字符串
 * @param {string} src 原始 Markdown 文本
 * @returns {string} HTML 字符串
 */
function renderMarkdown(src) {
  if (!src) return '';

  // 第 1 步：先把代码块抽出来（避免内部内容被其它规则误伤），用占位符代替
  const codeBlocks = [];
  let text = String(src).replace(CODE_BLOCK_RE, (match, code) => {
    const index = codeBlocks.push(
      '<pre class="code-block"><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>'
    ) - 1;
    return '@@CODEBLOCK' + index + '@@';
  });

  // 第 2 步：转义剩余文本
  text = escapeHtml(text);

  // 第 3 步：处理行内语法
  text = text.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // 第 4 步：逐行处理块级语法（标题、列表、引用、分割线、段落）
  const lines = text.split('\n');
  const htmlParts = [];
  let listType = null;   // 当前列表类型：ul / ol / null
  let paragraph = [];    // 当前段落中的行

  const flushParagraph = () => {
    if (paragraph.length) {
      htmlParts.push('<p>' + paragraph.join('<br>') + '</p>');
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listType) {
      htmlParts.push('</' + listType + '>');
      listType = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    let m;

    // 代码块占位符：直接作为独立块输出
    if (/^@@CODEBLOCK\d+@@$/.test(line.trim())) {
      flushParagraph();
      closeList();
      htmlParts.push(line.trim());
      continue;
    }
    // 空行：结束当前段落 / 列表
    if (/^\s*$/.test(line)) {
      flushParagraph();
      closeList();
      continue;
    }
    // 标题，例如 #### 小标题
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushParagraph();
      closeList();
      const level = m[1].length;
      htmlParts.push('<h' + level + '>' + m[2] + '</h' + level + '>');
      continue;
    }
    // 分割线 --- / *** / ___
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      flushParagraph();
      closeList();
      htmlParts.push('<hr>');
      continue;
    }
    // 无序列表 - / * / +
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      flushParagraph();
      if (listType !== 'ul') { closeList(); htmlParts.push('<ul>'); listType = 'ul'; }
      htmlParts.push('<li>' + m[1] + '</li>');
      continue;
    }
    // 有序列表 1. 2. 3.
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      flushParagraph();
      if (listType !== 'ol') { closeList(); htmlParts.push('<ol>'); listType = 'ol'; }
      htmlParts.push('<li>' + m[1] + '</li>');
      continue;
    }
    // 引用 > 文字
    if ((m = line.match(/^\s*>\s?(.*)$/))) {
      flushParagraph();
      closeList();
      htmlParts.push('<blockquote>' + m[1] + '</blockquote>');
      continue;
    }
    // 普通文本行，先攒进当前段落
    paragraph.push(line);
  }
  flushParagraph();
  closeList();

  // 第 5 步：把代码块占位符替换回真正的 HTML
  return htmlParts
    .join('\n')
    .replace(/@@CODEBLOCK(\d+)@@/g, (match, i) => codeBlocks[Number(i)] || '');
}

/* ---------------------------------------------------------------------------
   四、界面操作辅助函数
   ------------------------------------------------------------------------- */

/** 滚动到对话区域底部 */
function scrollToBottom() {
  chatArea.scrollTop = chatArea.scrollHeight;
}

/** 输入框根据内容自动调整高度 */
function autoResizeInput() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
}

/** 隐藏欢迎屏（一旦开始对话就不再显示） */
function hideWelcome() {
  if (welcomeEl) welcomeEl.style.display = 'none';
}

/** 生成"正在思考"的三点动画 HTML */
function typingHtml() {
  return '<span class="typing"><span></span><span></span><span></span></span>';
}

/**
 * 在消息列表中创建一个消息气泡
 * @param {string} role 角色：user / assistant / error
 * @returns {object} 返回 { el, bubble } 两个元素引用，便于后续更新内容
 */
function createMessage(role) {
  const el = document.createElement('div');
  el.className = 'message ' + role;

  // 头像
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  if (role === 'user') {
    avatar.textContent = '我';
  } else {
    // AI 与错误提示统一使用机器人图标（内联 SVG，避免额外图片请求）
    avatar.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/>' +
      '<path d="M2 14h2M20 14h2M15 13v2M9 13v2"/></svg>';
  }

  // 气泡
  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  el.appendChild(avatar);
  el.appendChild(bubble);
  messagesEl.appendChild(el);
  scrollToBottom();

  return { el: el, bubble: bubble };
}

/* ---------------------------------------------------------------------------
   五、核心：与后端通信并处理流式返回
   ------------------------------------------------------------------------- */

/**
 * 向本地后端发起流式请求
 * @param {Array} messages 对话历史
 * @param {object} handlers 回调集合：onDelta / onReasoning / onTool / onDone / onError
 */
async function streamChat(messages, handlers) {
  state.controller = new AbortController();

  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: messages }),
    signal: state.controller.signal
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw new Error('服务响应异常（' + response.status + '）' + errText.slice(0, 200));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  // 解析并分发一个完整的 SSE 数据块（以空行分隔）
  const handleBlock = (block) => {
    let eventName = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (!dataLines.length) return;

    let data = {};
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch (e) {
      return; // 忽略无法解析的块
    }

    if (eventName === 'delta' && data.text) handlers.onDelta(data.text);
    else if (eventName === 'reasoning' && data.text) handlers.onReasoning(data.text);
    else if (eventName === 'tool') handlers.onTool(data);
    else if (eventName === 'done') handlers.onDone();
    else if (eventName === 'error') handlers.onError(data.message || '未知错误');
  };

  // 持续读取网络流，遇到空行即视为一个完整事件块
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });

    let sepIndex;
    while ((sepIndex = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      if (block.trim()) handleBlock(block);
    }
  }
  if (buffer.trim()) handleBlock(buffer);
}

/**
 * 对外主流程：发送一条用户消息，并流式展示 AI 的回答
 * @param {string} text 用户输入内容
 */
async function sendMessage(text) {
  const content = text.trim();
  if (!content || state.isGenerating) return;

  // 1. 隐藏欢迎屏，展示用户消息
  hideWelcome();
  createMessage('user').bubble.textContent = content;

  // 2. 记录到对话历史
  state.messages.push({ role: 'user', text: content });

  // 3. 创建 AI 气泡，先显示"正在思考"
  const aiMessage = createMessage('assistant');
  const bubble = aiMessage.bubble;
  bubble.innerHTML = typingHtml();

  // 4. 进入生成状态（按钮变为"停止"）
  state.isGenerating = true;
  state.generationStartedAt = Date.now();
  sendBtn.classList.add('stopping');
  sendBtn.disabled = false;

  // 本次回答的累积变量
  let answerText = '';        // 正文
  let reasoningText = '';     // 思考过程
  let toolUsed = false;       // 是否触发联网搜索
  let firstDeltaReceived = false;

  // 根据当前累积内容重绘 AI 气泡
  const redraw = () => {
    let html = '';
    // 思考过程（可折叠）
    if (reasoningText) {
      html +=
        '<details class="reasoning"><summary>思考过程</summary>' +
        '<div class="reasoning-text">' + escapeHtml(reasoningText) + '</div></details>';
    }
    // 联网搜索提示
    if (toolUsed) {
      html += '<div class="tool-tip">已联网搜索最新信息</div>';
    }
    // 正文
    if (answerText) {
      html += renderMarkdown(answerText);
    } else if (!reasoningText && !toolUsed) {
      html += typingHtml();
    }
    bubble.innerHTML = html;
    scrollToBottom();
  };

  try {
    await streamChat(state.messages, {
      onDelta: (t) => {
        firstDeltaReceived = true;
        answerText += t;
        redraw();
      },
      onReasoning: (t) => {
        reasoningText += t;
        if (!firstDeltaReceived) redraw();
      },
      onTool: () => {
        toolUsed = true;
        redraw();
      },
      onDone: () => { /* 由 finally 统一收尾 */ },
      onError: (msg) => {
        throw new Error(msg);
      }
    });

    // 5. 若没有拿到任何正文，给出兜底提示
    if (!answerText) {
      answerText = '（这次没有收到内容，请再试一次。）';
    }
    redraw();

    // 6. 记录 AI 回答到历史，保持上下文连续
    state.messages.push({ role: 'assistant', text: answerText });
  } catch (err) {
    const isAbort = err && err.name === 'AbortError';
    if (isAbort) {
      // 用户主动停止：保留已经生成的文字
      if (answerText) {
        redraw();
        state.messages.push({ role: 'assistant', text: answerText });
      } else {
        bubble.innerHTML = '<p>已停止生成。</p>';
      }
    } else {
      // 出错：展示错误气泡，并把这条失败的用户消息从历史中移除，避免污染上下文
      state.messages.pop();
      const errBubble = createMessage('error').bubble;
      errBubble.textContent = '出错了：' + ((err && err.message) || err);
      scrollToBottom();
    }
  } finally {
    // 7. 恢复可输入状态
    state.isGenerating = false;
    state.controller = null;
    sendBtn.classList.remove('stopping');
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

/* ---------------------------------------------------------------------------
   六、事件绑定
   ------------------------------------------------------------------------- */

/**
 * 发送按钮的唯一入口：空闲时发送，生成中则作为"停止"。
 * 关键防护：刚发出请求的 600ms 内忽略再次点击/回车，
 * 避免"连击"或重复触发把刚刚发起的请求立刻中止。
 */
function handlePrimaryAction() {
  if (state.isGenerating) {
    if (Date.now() - state.generationStartedAt < 600) return;
    if (state.controller) state.controller.abort();
    return;
  }

  const text = inputEl.value;
  inputEl.value = '';
  autoResizeInput();
  sendMessage(text);
}

// 阻止浏览器的原生表单提交（避免刷新页面）
formEl.addEventListener('submit', (e) => {
  e.preventDefault();
});

// 点击发送 / 停止按钮
sendBtn.addEventListener('click', handlePrimaryAction);

// 输入框键盘事件：Enter 发送，Shift + Enter 换行
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    // 生成中按 Enter 不做任何事（不打断当前回答）
    if (state.isGenerating) return;
    handlePrimaryAction();
  }
});

// 输入时自动调整高度
inputEl.addEventListener('input', autoResizeInput);

// 点击欢迎屏上的引导问题：直接发送
document.querySelectorAll('.suggestion').forEach((btn) => {
  btn.addEventListener('click', () => {
    sendMessage(btn.getAttribute('data-prompt') || btn.textContent);
  });
});

// 清空对话（同时清空上下文，让 AI 忘记之前聊过的内容）
clearBtn.addEventListener('click', () => {
  if (state.isGenerating) return;
  state.messages = [];
  messagesEl.innerHTML = '';
  if (welcomeEl) welcomeEl.style.display = '';
  inputEl.focus();
});

// 页面加载完成后聚焦输入框
window.addEventListener('load', () => inputEl.focus());
