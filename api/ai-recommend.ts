import { getAiRecommendation } from '../server/aiRecommend'

type ApiRequest = {
  method?: string
  body?: {
    imageDataUrl?: unknown
    filename?: unknown
    localRecommendation?: unknown
  }
}

type ApiResponse = {
  status: (code: number) => {
    json: (payload: unknown) => void
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const { imageDataUrl, filename, localRecommendation } = req.body ?? {}

    if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
      res.status(400).json({ error: '缺少有效的图片数据。' })
      return
    }

    const recommendation = await getAiRecommendation({
      imageDataUrl,
      filename: typeof filename === 'string' ? filename : undefined,
      localRecommendation:
        typeof localRecommendation === 'string' ? localRecommendation : undefined,
    })

    res.status(200).json(recommendation)
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'AI 推荐失败。',
    })
  }
}
