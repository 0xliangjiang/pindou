type GenerationStrategy = 'accurate' | 'reduced' | 'craft'
type PreprocessPreset = 'portrait' | 'landscape' | 'illustration'

export type RecommendationPayload = {
  imageDataUrl: string
  filename?: string
  localRecommendation?: string
}

export type RecommendationResult = {
  preprocessPreset: PreprocessPreset
  generationStrategy: GenerationStrategy
  ditherStrength: number
  gridSize: number
  colorLimit: number
  summary: string
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

type ResponsesApiJson = {
  output_text?: string
  output?: Array<{
    type?: string
    content?: Array<{
      type?: string
      text?: string
    }>
  }>
}

const extractText = (responseJson: ResponsesApiJson) => {
  if (typeof responseJson.output_text === 'string' && responseJson.output_text) {
    return responseJson.output_text
  }

  if (Array.isArray(responseJson.output)) {
    const texts: string[] = []

    for (const item of responseJson.output) {
      if (item.type !== 'message' || !Array.isArray(item.content)) {
        continue
      }

      for (const part of item.content) {
        if (part.type === 'output_text' && typeof part.text === 'string') {
          texts.push(part.text)
        }
      }
    }

    if (texts.length) {
      return texts.join('\n')
    }
  }

  return ''
}

const parseRecommendation = (text: string): RecommendationResult => {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) {
    throw new Error('AI 返回内容无法解析。')
  }

  const parsed = JSON.parse(match[0]) as Partial<RecommendationResult>

  const preprocessPreset =
    parsed.preprocessPreset === 'landscape' || parsed.preprocessPreset === 'illustration'
      ? parsed.preprocessPreset
      : 'portrait'

  const generationStrategy =
    parsed.generationStrategy === 'reduced' || parsed.generationStrategy === 'craft'
      ? parsed.generationStrategy
      : 'accurate'

  return {
    preprocessPreset,
    generationStrategy,
    ditherStrength: clamp(Math.round(parsed.ditherStrength ?? 72), 0, 100),
    gridSize: clamp(Math.round(parsed.gridSize ?? 48), 28, 72),
    colorLimit: clamp(Math.round(parsed.colorLimit ?? 18), 8, 36),
    summary:
      typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : 'AI 已给出一组推荐参数。',
  }
}

export const getAiRecommendation = async (
  payload: RecommendationPayload,
): Promise<RecommendationResult> => {
  const apiKey = process.env.OPENAI_API_KEY

  if (!apiKey) {
    throw new Error('服务端未配置 OPENAI_API_KEY。')
  }

  const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'
  const prompt = [
    '你是拼豆图纸参数推荐助手。',
    '请根据上传图片推荐最适合的预处理类型、生成策略、抖动强度、图纸宽度和最大颜色数。',
    '允许的 preprocessPreset: portrait, landscape, illustration。',
    '允许的 generationStrategy: accurate, reduced, craft。',
    'gridSize 必须在 28-72 之间，colorLimit 必须在 8-36 之间，ditherStrength 必须在 0-100 之间。',
    '如果是人像，优先保护肤色；如果是风景，优先层次和天空/草地；如果是插画，优先边界和色块。',
    '请只返回 JSON，不要包含 markdown。',
    'JSON schema: {"preprocessPreset":"portrait|landscape|illustration","generationStrategy":"accurate|reduced|craft","ditherStrength":0,"gridSize":48,"colorLimit":18,"summary":"一句中文建议"}',
    payload.filename ? `文件名: ${payload.filename}` : '',
    payload.localRecommendation ? `本地规则基线: ${payload.localRecommendation}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      instructions: '你是一名专业的拼豆图纸参数分析助手。',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            {
              type: 'input_image',
              image_url: payload.imageDataUrl,
              detail: 'low',
            },
          ],
        },
      ],
      max_output_tokens: 300,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`OpenAI 请求失败: ${response.status} ${errorText}`)
  }

  const responseJson = (await response.json()) as ResponsesApiJson
  const text = extractText(responseJson)

  if (!text) {
    throw new Error('AI 没有返回可解析的文本结果。')
  }

  return parseRecommendation(text)
}
