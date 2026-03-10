import { getAiRecommendation } from '../server/aiRecommend.js'

type ApiRequest = {
  method?: string
  body?: {
    imageDataUrl?: unknown
    filename?: unknown
    localRecommendation?: unknown
    imageInsights?: unknown
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
    const { imageDataUrl, filename, localRecommendation, imageInsights } = req.body ?? {}

    if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
      res.status(400).json({ error: '缺少有效的图片数据。' })
      return
    }

    const insights = imageInsights && typeof imageInsights === 'object' ? imageInsights as Record<string, unknown> : {}

    const recommendation = await getAiRecommendation({
      imageDataUrl,
      filename: typeof filename === 'string' ? filename : undefined,
      localRecommendation:
        typeof localRecommendation === 'string' ? localRecommendation : undefined,
      imageInsights: {
        avgSaturation: Number(insights.avgSaturation ?? 0),
        avgLuma: Number(insights.avgLuma ?? 0),
        detailScore: Number(insights.detailScore ?? 0),
        paletteSpread: Number(insights.paletteSpread ?? 0),
        skinRatio: Number(insights.skinRatio ?? 0),
        aspectRatio: Number(insights.aspectRatio ?? 1),
        contrast: typeof insights.contrast === 'number' ? insights.contrast : undefined,
        dominantHue: typeof insights.dominantHue === 'string' ? insights.dominantHue : undefined,
        edgeDirection: typeof insights.edgeDirection === 'string' ? insights.edgeDirection : undefined,
        complexity: typeof insights.complexity === 'string' ? insights.complexity : undefined,
        brightnessDistribution: typeof insights.brightnessDistribution === 'string' ? insights.brightnessDistribution : undefined,
      },
    })

    res.status(200).json(recommendation)
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'AI 推荐失败。',
    })
  }
}
