import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { getAiRecommendation } from './server/aiRecommend'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'local-ai-recommend-api',
      configureServer(server) {
        server.middlewares.use('/api/ai-recommend', async (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Method not allowed' }))
            return
          }

          try {
            const chunks: Buffer[] = []

            for await (const chunk of req) {
              chunks.push(Buffer.from(chunk))
            }

            const raw = Buffer.concat(chunks).toString('utf8')
            const body = raw ? JSON.parse(raw) : {}

            if (typeof body.imageDataUrl !== 'string' || !body.imageDataUrl.startsWith('data:image/')) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: '缺少有效的图片数据。' }))
              return
            }

            const recommendation = await getAiRecommendation({
              imageDataUrl: body.imageDataUrl,
              filename: typeof body.filename === 'string' ? body.filename : undefined,
              localRecommendation:
                typeof body.localRecommendation === 'string'
                  ? body.localRecommendation
                  : undefined,
            })

            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(recommendation))
          } catch (error) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : 'AI 推荐失败。',
              }),
            )
          }
        })
      },
    },
  ],
})
