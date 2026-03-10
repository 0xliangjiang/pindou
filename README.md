# Pindou

前端是 Vite + React，支持本地推荐参数、OpenAI / Gemini 直连推荐，以及独立部署的 MiniMax MCP bridge。

## Frontend

```bash
npm install
npm run dev
```

如果你把 AI 推荐服务单独部署在后端，前端通过下面的环境变量指过去：

```bash
VITE_AI_RECOMMEND_API_URL=https://your-backend.example.com
```

前端会请求：

```text
POST {VITE_AI_RECOMMEND_API_URL}/api/ai-recommend
```

可以先复制一份环境变量模板：

```bash
cp .env.local.example .env.local
```

## Local Start/Stop

统一启停前后端：

```bash
npm run local:start
npm run local:stop
npm run local:restart
npm run local:status
npm run local:logs
```

脚本会：

- 自动读取 `.env.local`
- 启动 MiniMax MCP bridge
- 启动前端 Vite 开发服务
- 把 PID 写到 `.run/`
- 把日志写到 `logs/`

## MiniMax MCP Bridge

这个服务适合单独部署在常驻后端，不适合轻量 serverless。

### 依赖

- Node.js 20+
- `uvx` 可用
- MiniMax Coding Plan key
- 已安装并可运行的 `minimax-coding-plan-mcp`

### 启动

```bash
MINIMAX_API_KEY=your_key \
MINIMAX_MCP_COMMAND=uvx \
MINIMAX_MCP_ARGS="minimax-coding-plan-mcp -y" \
PORT=8787 \
npm run bridge:minimax
```

默认接口：

- `GET /health`
- `POST /api/ai-recommend`

### 请求体

```json
{
  "imageDataUrl": "data:image/png;base64,...",
  "filename": "demo.png",
  "localRecommendation": "推荐 人像 + 最接近原图，抖动 76，色数 22。",
  "imageInsights": {
    "avgSaturation": 0.42,
    "avgLuma": 132.1,
    "detailScore": 181.4,
    "paletteSpread": 29,
    "skinRatio": 0.12,
    "aspectRatio": 1.33
  }
}
```

### 返回

```json
{
  "preprocessPreset": "portrait",
  "generationStrategy": "accurate",
  "ditherStrength": 78,
  "gridSize": 52,
  "colorLimit": 22,
  "summary": "推荐人像 + 最接近原图，保留肤色和细节。"
}
```

## Provider Notes

- `OpenAI` 和 `Gemini` 走真图片输入
- `MiniMax` 的 Coding Plan 适合通过 MCP `understand_image` 做图片理解
- 如果走独立后端桥接，建议前端统一只配 `VITE_AI_RECOMMEND_API_URL`
