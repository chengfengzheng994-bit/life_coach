# AI 人生教练（Life Coach）

一个通过「火山方舟 DeepSeek-V4.1-Flash」大模型与你对话的网页版人生教练。
它会倾听你的困惑、向你提问、给出具体可行的建议，陪你一起成长。

---

## 一、如何运行（3 步）

> 需要电脑上已安装 **Node.js 18 或更高版本**（可访问 https://nodejs.org 下载安装）。

1. 打开命令行（Windows 用 PowerShell），进入本项目目录：

   ```powershell
   cd d:\trae_learning\life_coach
   ```

2. 配置 API 密钥（二选一）：
   - **方式一（推荐）**：在项目根目录创建 `.env` 文件，写入：

     ```
     ARK_API_KEY=你的火山方舟 API Key
     ```

     该文件已被 `.gitignore` 忽略，`node server.js` 启动时会自动读取。
   - **方式二**：启动前在终端设置环境变量：

     ```powershell
     $env:ARK_API_KEY="你的火山方舟 API Key"
     ```

3. 启动服务：

   ```powershell
   node server.js
   ```

4. 看到如下提示后，在浏览器打开 http://localhost:3000 即可：

   ```
   AI 人生教练服务已启动
   请在浏览器打开：http://localhost:3000
   ```

按 `Ctrl + C` 可以停止服务。

> 项目**无需安装任何第三方依赖**，用 Node.js 内置能力即可运行。

---

## 二、目录结构

| 文件 | 作用 |
| --- | --- |
| `server.js` | 本地 Node.js 服务：托管静态页面，把 `/api/chat` 交给 `lib/chat.js` |
| `lib/chat.js` | 对话核心逻辑（本地与 Vercel 共用）：调用火山方舟、解析 SSE、转发事件；所有密钥只从环境变量读取 |
| `api/chat.js` | Vercel Serverless 入口，对应线上 `POST /api/chat` |
| `vercel.json` | Vercel 函数配置（超时上限 60 秒） |
| `public/index.html` | 前端页面结构：顶部标题栏、对话区（欢迎屏 + 消息列表）、底部输入区 |
| `public/styles.css` | 页面样式：青绿治愈系配色、Flexbox/Grid 布局、消息气泡、动画、响应式适配 |
| `public/app.js` | 前端逻辑：对话状态管理、SSE 流式接收、Markdown 渲染、交互处理 |
| `AI Rules` | 项目开发规范 |

---

## 三、页面结构与布局说明

页面从上到下分为三个区域，整体使用纵向 Flexbox 铺满整个屏幕：

1. **顶部标题栏 `<header>`**
   - 左侧：品牌图标 + 标题「AI 人生教练」+ 副标题
   - 右侧：「清空对话」按钮（清空消息，同时清空上下文记忆）
   - 样式：半透明白底 + 毛玻璃模糊 + 底部细边框

2. **中间对话区 `<main>`**（独立滚动）
   - **欢迎屏**：首次进入时显示。包含一句问候语和 4 个「引导问题」按钮（Grid 两列布局，手机端自动变为一列）。点击按钮即可直接发送该问题。
   - **消息列表**：动态插入的气泡。用户消息靠右（蓝色渐变），AI 消息靠左（白色卡片）。
     - AI 气泡支持：**思考过程**折叠区、**联网搜索**提示、Markdown 排版（标题 / 列表 / 粗体 / 引用 / 代码块 / 链接）。
     - 等待时显示三点跳动动画。
   - **错误气泡**：请求失败时以红色气泡提示。

3. **底部输入区 `<footer>`**
   - 多行输入框（随内容自动增高，最高 160px）+ 圆形发送按钮
   - 生成过程中，按钮变为红色「停止」，点击可中断
   - 下方一行小字提示（内容由 AI 生成，仅供参考）

---

## 四、交互与快捷键

| 操作 | 效果 |
| --- | --- |
| 输入框内按 `Enter` | 发送消息 |
| 按 `Shift + Enter` | 换行 |
| 生成中点击发送按钮 | 停止本次生成（保留已生成内容） |
| 点击「清空对话」 | 清空所有消息与上下文记忆 |
| 点击引导问题 | 直接发送该问题 |

---

## 五、技术要点

- **前后端分离**：浏览器不直接接触 API Key，所有模型请求都由服务端转发，既安全又彻底避免了 CORS 问题。
- **流式输出**：后端把火山方舟的 SSE 事件（`response.output_text.delta` 等）转成 `delta / reasoning / tool / done / error` 五类事件，前端边收边渲染，回答逐字出现。
- **上下文记忆**：前端保存完整对话历史，每次请求把整段历史一起发送，因此 AI 记得之前聊过的内容。
- **请求参数**：模型 `deepseek-v4-1-flash-260910`，`stream: true`，`temperature: 0.6`，超时 **55 秒**，并开启联网搜索工具。
- **人设设定**：教练的性格与原则写在 [lib/chat.js](file:///d:/trae_learning/life_coach/lib/chat.js) 的 `SYSTEM_PROMPT` 常量中，可直接修改。
- **零依赖 Markdown 渲染**：在 [app.js](file:///d:/trae_learning/life_coach/public/app.js) 中自行实现，先做 HTML 转义再渲染，防止 XSS。

---

## 六、常见问题

**Q：提示「请求超时」？**
A：单次请求超过 55 秒会自动中断。可稍后重试，或通过环境变量 `REQUEST_TIMEOUT`（毫秒）调大；Vercel 上该值不应超过 60 秒。

**Q：想更换模型或 API Key？**
A：只通过环境变量配置，无需改代码：`ARK_API_KEY`（必填）、`ARK_MODEL`（可选，默认 `deepseek-v4-1-flash-260910`）、`PORT`（可选）、`ARK_API_URL`（可选）。本地 PowerShell 示例：

```powershell
$env:ARK_API_KEY="新的密钥"
$env:ARK_MODEL="新的模型名称"
node server.js
```

部署到 Vercel 时，在项目的 Settings → Environment Variables 中添加同名变量即可。

**Q：端口 3000 被占用？**
A：用 `$env:PORT=3001; node server.js` 换一个端口后，访问 http://localhost:3001。

---

## 七、部署到 Vercel

1. 把项目推送到 GitHub / GitLab 仓库。
2. Vercel 控制台 → Add New → Project → 导入该仓库，Framework Preset 选择 `Other`。
3. 在 Settings → Environment Variables 添加：

   | 变量名 | 必填 | 说明 |
   | --- | --- | --- |
   | `ARK_API_KEY` | 是 | 火山方舟 API Key |
   | `ARK_MODEL` | 否 | 默认 `deepseek-v4-1-flash-260910` |
   | `ARK_API_URL` | 否 | 默认官方接口地址 |
   | `REQUEST_TIMEOUT` | 否 | 毫秒，默认 55000 |

4. 重新部署（Redeploy）后访问域名验证。

说明：`public/` 由 Vercel 作为静态资源托管，`api/chat.js` 自动映射为 `POST /api/chat`，前端无需修改。

---

## 八、后续可优化方向

- 增加对话持久化（localStorage 或数据库），刷新后不丢失历史。
- 增加「多会话」侧边栏，区分不同话题。
- 支持 Markdown 代码高亮、回答复制 / 重新生成按钮。
- 增加深色模式。
- ~~部署到服务器时，API Key 建议改为环境变量注入~~（已完成，密钥只从环境变量读取）。
