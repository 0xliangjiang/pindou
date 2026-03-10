type GenerationStrategy = 'accurate' | 'reduced' | 'craft'
type PreprocessPreset = 'portrait' | 'landscape' | 'illustration' | 'chibi'

type ImageInsights = {
  avgSaturation: number
  avgLuma: number
  detailScore: number
  paletteSpread: number
  skinRatio: number
  aspectRatio: number
  contrast?: number
  dominantHue?: string
  edgeDirection?: string
  complexity?: string
  brightnessDistribution?: string
}

export type RecommendationPayload = {
  imageDataUrl: string
  filename?: string
  localRecommendation?: string
  imageInsights?: ImageInsights
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

const parseRecommendation = (text: string): RecommendationResult => {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) {
    throw new Error('AI 返回内容无法解析。')
  }

  const parsed = JSON.parse(match[0]) as Partial<RecommendationResult>

  const preprocessPreset =
    parsed.preprocessPreset === 'landscape' ||
    parsed.preprocessPreset === 'illustration' ||
    parsed.preprocessPreset === 'chibi'
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

const buildPrompt = (payload: RecommendationPayload): string => {
  const systemContext = `你是拼豆图纸参数推荐专家。拼豆是一种手工艺品，将彩色小珠子排列成图案后熨烫固定。

## 拼豆生成的核心挑战
1. **色域限制**: 实体豆子的色域远小于屏幕颜色范围，直接转换会导致对比度不足、轮廓边界不清晰
2. **网格分辨率**: 图案由离散的珠子组成，细节会被简化，复杂细节会产生噪点
3. **颜色过渡**: 通过Floyd-Steinberg抖动算法模拟颜色渐变，但抖动过多会产生杂色噪点
4. **制作难度**: 颜色太多会增加制作时间和难度，建议控制在合理范围内
5. **黑边问题**: 传统RGB均值算法会导致深浅像素平均后变成灰色，需要保护轮廓边界

## 用户常见问题
- **预览过糊/细节丢失**: 需要增加网格尺寸，提高细节保留
- **噪点太多/颜色太杂**: 需要降低颜色数量，减少抖动强度
- **轮廓不清晰**: 需要增强对比度，使用更低的抖动
- **颜色数量太多**: 需要使用 reduced 策略，减少制作难度

## 参数详解

### preprocessPreset (预处理类型)
- **portrait (人像)**: 优化肤色表现，保护面部轮廓，轻微提亮，适合真人照片
- **landscape (风景)**: 增强绿色和蓝色，提升天空和植被表现，适合自然风景
- **illustration (插画)**: 增强边界对比，保持色块纯净，适合卡通/插画/Logo
- **chibi (Q版角色)**: 专为二次元Q版角色优化，保持线稿清晰，低抖动优先

### generationStrategy (生成策略)
- **accurate (最接近原图)**: 优先还原色彩，适合高细节照片，颜色数量较多
- **reduced (更少颜色)**: 减少颜色数量，简化制作难度，适合新手或简单图案
- **craft (更适合拼豆)**: 平衡还原度和制作难度，增强对比度，推荐大多数情况使用

### ditherStrength (抖动强度 0-100)
- **低值(0-25)**: 色块清晰，边界锐利，适合简洁图案、卡通、Q版角色
- **中值(25-55)**: 平衡细节和清晰度，适合人像、插画
- **高值(55-100)**: 更多细节，但会产生噪点，仅适合复杂风景照片
- **注意**: 大多数拼豆爱好者更喜欢清晰的色块而非过度抖动

### gridSize (图纸宽度 28-72)
- 更大 = 更多细节，但制作时间更长
- **新手建议**: 32-40 (约10cm)
- **进阶建议**: 44-56 (约15cm)
- **高细节**: 56-72 (约20cm)

### colorLimit (最大颜色数 8-36)
- **新手友好**: 8-12色，制作简单
- **适中复杂度**: 14-20色，平衡效果和难度
- **高还原度**: 22-36色，需要更多耐心
- **实用建议**: 控制在20色以内可以显著降低制作难度`

  const localInsightsGuide = `
## 本地图像指标解读
- **avgSaturation (0-1)**: 饱和度，>0.5 为高饱和，适合 craft 策略和较低抖动
- **avgLuma (0-255)**: 平均亮度，<100 偏暗需要提亮，>180 偏亮需要注意细节保留
- **detailScore**: 边缘能量，>150 为高细节，需要更大 gridSize；高细节+高抖动=噪点多
- **paletteSpread**: 颜色桶数量，>25 为色彩丰富，需要更高 colorLimit
- **skinRatio (0-1)**: 肤色比例，>0.15 可能是人像或 Q 版，需要保护肤色
- **aspectRatio**: 高宽比，>1.2 为竖图，<0.8 为横图
- **contrast (0-1)**: 对比度，>0.4 为高对比，适合低抖动保持清晰边界
- **dominantHue**: 主色调，影响 preprocessPreset 选择
- **complexity**: 整体复杂度评估，high 需要更大 gridSize 和更高 colorLimit
- **brightnessDistribution**: 亮度分布，dark 需要提亮，bright 需要保护高光`

  const fewShotExamples = `
## 推荐示例

### 示例1: 高饱和二次元Q版角色
输入: skinRatio=0.12, avgSaturation=0.65, detailScore=180, paletteSpread=22, contrast=0.35
推荐: {"preprocessPreset":"chibi","generationStrategy":"craft","ditherStrength":18,"gridSize":52,"colorLimit":16,"summary":"高饱和Q版角色，craft策略增强对比，极低抖动保持线稿清晰，颜色控制在16色降低制作难度"}

### 示例2: 复杂风景照片
输入: skinRatio=0.02, avgSaturation=0.38, detailScore=145, paletteSpread=30, contrast=0.28
推荐: {"preprocessPreset":"landscape","generationStrategy":"accurate","ditherStrength":58,"gridSize":56,"colorLimit":26,"summary":"复杂风景，accurate还原色彩，中等抖动平衡细节与噪点，大网格保留层次"}

### 示例3: 简单卡通图标/Logo
输入: skinRatio=0.0, avgSaturation=0.72, detailScore=35, paletteSpread=6, contrast=0.55
推荐: {"preprocessPreset":"illustration","generationStrategy":"reduced","ditherStrength":8,"gridSize":36,"colorLimit":10,"summary":"简洁色块图案，reduced策略减少颜色，极低抖动保持边界锐利，新手友好"}

### 示例4: 真人肖像照片
输入: skinRatio=0.35, avgSaturation=0.28, detailScore=165, paletteSpread=28, contrast=0.32
推荐: {"preprocessPreset":"portrait","generationStrategy":"craft","ditherStrength":45,"gridSize":52,"colorLimit":18,"summary":"真人肖像，craft平衡还原与制作难度，中等抖动保留面部细节，保护肤色"}

### 示例5: 低对比度暗色图片
输入: skinRatio=0.0, avgSaturation=0.25, avgLuma=85, detailScore=90, contrast=0.18
推荐: {"preprocessPreset":"illustration","generationStrategy":"craft","ditherStrength":35,"gridSize":48,"colorLimit":14,"summary":"低对比度暗图，craft增强对比度，较低抖动避免噪点，控制颜色数量"}

### 示例6: 新手友好的简单图案
输入: detailScore=40, paletteSpread=8, complexity="low"
推荐: {"preprocessPreset":"illustration","generationStrategy":"reduced","ditherStrength":5,"gridSize":32,"colorLimit":8,"summary":"简单图案，reduced策略+极低颜色数，新手友好，快速完成"}`

  const contextInfo = [
    payload.filename ? `文件名: ${payload.filename}` : '',
    payload.localRecommendation ? `本地规则基线: ${payload.localRecommendation}` : '',
    payload.imageInsights
      ? `本地图像指标: ${JSON.stringify(payload.imageInsights, null, 2)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')

  return [
    systemContext,
    localInsightsGuide,
    fewShotExamples,
    '---',
    contextInfo,
    '---',
    '请根据本地图像指标，推荐最合适的参数。',
    '重要原则：',
    '1. 优先考虑制作难度，颜色数量尽量控制在20色以内',
    '2. 抖动强度不要过高，大多数情况控制在50以内',
    '3. 高对比度图片使用低抖动，低对比度图片适当提高抖动',
    '4. 新手用户优先推荐 reduced 策略',
    '',
    '请只返回 JSON，不要包含 markdown 代码块标记。',
    'JSON schema: {"preprocessPreset":"portrait|landscape|illustration|chibi","generationStrategy":"accurate|reduced|craft","ditherStrength":0,"gridSize":48,"colorLimit":18,"summary":"一句中文建议，说明推荐理由和制作难度"}',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export const getAiRecommendation = async (
  payload: RecommendationPayload,
): Promise<RecommendationResult> => {
  const apiKey = process.env.MINIMAX_API_KEY
  if (!apiKey) {
    throw new Error('服务端未配置 MINIMAX_API_KEY。')
  }

  const prompt = buildPrompt(payload)
  const model = process.env.MINIMAX_MODEL ?? 'MiniMax-M2'
  const groupId = process.env.MINIMAX_GROUP_ID

  // Code Plan 使用 api.minimax.chat，普通用户使用 api.minimaxi.chat
  const baseUrl = groupId
    ? `https://api.minimax.chat/v1/text/chatcompletion_v2?GroupId=${groupId}`
    : 'https://api.minimax.chat/v1/text/chatcompletion_v2'

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.1,
      max_tokens: 500,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`MiniMax 请求失败: ${response.status} ${errorText}`)
  }

  const responseJson = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    reply?: string
    base_resp?: { status_msg?: string }
    error?: { message?: string }
  }

  // OpenAI 兼容格式
  let text = ''
  if (responseJson.choices?.[0]?.message?.content) {
    text = responseJson.choices[0].message.content
  } else if (typeof responseJson.reply === 'string') {
    // 旧格式兼容
    text = responseJson.reply
  }

  if (!text) {
    if (responseJson.error?.message) {
      throw new Error(`MiniMax API 错误: ${responseJson.error.message}`)
    }
    if (responseJson.base_resp?.status_msg) {
      throw new Error(`MiniMax 返回异常: ${responseJson.base_resp.status_msg}`)
    }
    throw new Error('AI 没有返回可解析的文本结果。')
  }

  return parseRecommendation(text)
}
