import { useEffect, useMemo, useRef, useState, startTransition } from 'react'
import type { ChangeEvent, DragEvent, MouseEvent } from 'react'
import './App.css'
import { beadPalette, type PaletteColor } from './palette'

type SourceMode = 'photo' | 'pattern'
type GenerationStrategy = 'accurate' | 'reduced' | 'craft'
type EditMode = 'inspect' | 'paint' | 'box'
type PreprocessPreset = 'portrait' | 'landscape' | 'illustration'

type Rgb = {
  r: number
  g: number
  b: number
}

type Lab = {
  l: number
  a: number
  b: number
}

type Cell = {
  x: number
  y: number
  color: PaletteColor
}

type PatternResult = {
  rows: number
  cols: number
  cells: Cell[]
  legend: Array<{ color: PaletteColor; count: number }>
  previewDataUrl: string
}

type CanvasMetrics = {
  cellSize: number
  padding: number
}

type ReplaceState = {
  fromId: string
  toId: string
}

type PatternSnapshot = {
  rows: number
  cols: number
  cells: Cell[]
}

type WeightedColor = {
  color: Rgb
  weight: number
}

type Recommendation = {
  preprocessPreset: PreprocessPreset
  generationStrategy: GenerationStrategy
  ditherStrength: number
  gridSize: number
  colorLimit: number
  summary: string
}

type RecommendationApiResult = Recommendation

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

const hexToRgb = (hex: string): Rgb => {
  const normalized = hex.replace('#', '')
  const value = Number.parseInt(normalized, 16)
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  }
}

const srgbToLinear = (value: number) => {
  const channel = value / 255
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

const rgbToLab = ({ r, g, b }: Rgb): Lab => {
  const red = srgbToLinear(r)
  const green = srgbToLinear(g)
  const blue = srgbToLinear(b)

  const x = (red * 0.4124 + green * 0.3576 + blue * 0.1805) / 0.95047
  const y = (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 1
  const z = (red * 0.0193 + green * 0.1192 + blue * 0.9505) / 1.08883

  const transform = (value: number) =>
    value > 0.008856 ? value ** (1 / 3) : 7.787 * value + 16 / 116

  const fx = transform(x)
  const fy = transform(y)
  const fz = transform(z)

  return {
    l: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  }
}

const subtractRgb = (left: Rgb, right: Rgb): Rgb => ({
  r: left.r - right.r,
  g: left.g - right.g,
  b: left.b - right.b,
})

const mixTowards = (value: number, target: number, amount: number) =>
  value * (1 - amount) + target * amount

const ciede2000 = (left: Lab, right: Lab) => {
  const avgL = (left.l + right.l) / 2
  const c1 = Math.sqrt(left.a ** 2 + left.b ** 2)
  const c2 = Math.sqrt(right.a ** 2 + right.b ** 2)
  const avgC = (c1 + c2) / 2
  const g = 0.5 * (1 - Math.sqrt((avgC ** 7) / (avgC ** 7 + 25 ** 7)))
  const a1Prime = left.a * (1 + g)
  const a2Prime = right.a * (1 + g)
  const c1Prime = Math.sqrt(a1Prime ** 2 + left.b ** 2)
  const c2Prime = Math.sqrt(a2Prime ** 2 + right.b ** 2)
  const avgCPrime = (c1Prime + c2Prime) / 2

  const hPrime = (a: number, b: number) => {
    if (a === 0 && b === 0) {
      return 0
    }
    const angle = (Math.atan2(b, a) * 180) / Math.PI
    return angle >= 0 ? angle : angle + 360
  }

  const h1Prime = hPrime(a1Prime, left.b)
  const h2Prime = hPrime(a2Prime, right.b)
  const deltaLPrime = right.l - left.l
  const deltaCPrime = c2Prime - c1Prime

  let deltahPrime = 0
  if (c1Prime * c2Prime !== 0) {
    if (Math.abs(h2Prime - h1Prime) <= 180) {
      deltahPrime = h2Prime - h1Prime
    } else if (h2Prime <= h1Prime) {
      deltahPrime = h2Prime - h1Prime + 360
    } else {
      deltahPrime = h2Prime - h1Prime - 360
    }
  }

  const deltaHPrime = 2 * Math.sqrt(c1Prime * c2Prime) * Math.sin(((deltahPrime / 2) * Math.PI) / 180)

  let avgHPrime = h1Prime + h2Prime
  if (c1Prime * c2Prime === 0) {
    avgHPrime = h1Prime + h2Prime
  } else if (Math.abs(h1Prime - h2Prime) > 180) {
    avgHPrime += h1Prime + h2Prime < 360 ? 360 : -360
    avgHPrime /= 2
  } else {
    avgHPrime /= 2
  }

  const t =
    1 -
    0.17 * Math.cos(((avgHPrime - 30) * Math.PI) / 180) +
    0.24 * Math.cos(((2 * avgHPrime) * Math.PI) / 180) +
    0.32 * Math.cos(((3 * avgHPrime + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * avgHPrime - 63) * Math.PI) / 180)

  const deltaTheta = 30 * Math.exp(-(((avgHPrime - 275) / 25) ** 2))
  const rc = 2 * Math.sqrt((avgCPrime ** 7) / (avgCPrime ** 7 + 25 ** 7))
  const sl = 1 + (0.015 * ((avgL - 50) ** 2)) / Math.sqrt(20 + (avgL - 50) ** 2)
  const sc = 1 + 0.045 * avgCPrime
  const sh = 1 + 0.015 * avgCPrime * t
  const rt = -Math.sin(((2 * deltaTheta) * Math.PI) / 180) * rc

  const lTerm = deltaLPrime / sl
  const cTerm = deltaCPrime / sc
  const hTerm = deltaHPrime / sh

  return Math.sqrt(lTerm ** 2 + cTerm ** 2 + hTerm ** 2 + rt * cTerm * hTerm)
}

const applyGenerationStrategy = (color: Rgb, strategy: GenerationStrategy): Rgb => {
  const average = (color.r + color.g + color.b) / 3

  if (strategy === 'reduced') {
    return {
      r: clamp(Math.round(color.r * 0.97 + average * 0.03), 0, 255),
      g: clamp(Math.round(color.g * 0.97 + average * 0.03), 0, 255),
      b: clamp(Math.round(color.b * 0.97 + average * 0.03), 0, 255),
    }
  }

  if (strategy === 'craft') {
    return {
      r: clamp(Math.round(color.r + (color.r - average) * 0.12 + 4), 0, 255),
      g: clamp(Math.round(color.g + (color.g - average) * 0.12 + 4), 0, 255),
      b: clamp(Math.round(color.b + (color.b - average) * 0.12 + 4), 0, 255),
    }
  }

  return color
}

const preprocessColor = (color: Rgb, preset: PreprocessPreset): Rgb => {
  const average = (color.r + color.g + color.b) / 3

  if (preset === 'portrait') {
    return {
      r: clamp(Math.round(mixTowards(color.r + 6, average + 10, 0.08)), 0, 255),
      g: clamp(Math.round(mixTowards(color.g + 2, average + 5, 0.12)), 0, 255),
      b: clamp(Math.round(mixTowards(color.b - 4, average, 0.14)), 0, 255),
    }
  }

  if (preset === 'landscape') {
    return {
      r: clamp(Math.round(color.r * 1.02), 0, 255),
      g: clamp(Math.round(color.g * 1.06 + (color.g - average) * 0.08), 0, 255),
      b: clamp(Math.round(color.b * 1.08 + (color.b - average) * 0.1), 0, 255),
    }
  }

  return {
    r: clamp(Math.round(color.r + (color.r - average) * 0.12), 0, 255),
    g: clamp(Math.round(color.g + (color.g - average) * 0.12), 0, 255),
    b: clamp(Math.round(color.b + (color.b - average) * 0.12), 0, 255),
  }
}

const clusterWeightedColors = (colors: WeightedColor[], clusterCount: number) => {
  const targetCount = Math.max(1, Math.min(clusterCount, colors.length))
  const step = Math.max(1, Math.floor(colors.length / targetCount))
  let centroids = Array.from({ length: targetCount }, (_, index) => colors[Math.min(index * step, colors.length - 1)].color).map(
    (color) => ({ ...color }),
  )

  for (let iteration = 0; iteration < 6; iteration += 1) {
    const groups = Array.from({ length: targetCount }, () => [] as WeightedColor[])

    for (const entry of colors) {
      const colorLab = rgbToLab(entry.color)
      let bestIndex = 0
      let bestDistance = Number.POSITIVE_INFINITY

      centroids.forEach((centroid, index) => {
        const distance = ciede2000(colorLab, rgbToLab(centroid))
        if (distance < bestDistance) {
          bestDistance = distance
          bestIndex = index
        }
      })

      groups[bestIndex].push(entry)
    }

    centroids = groups.map((group, index) => {
      if (!group.length) {
        return centroids[index]
      }

      const totalWeight = group.reduce((sum, item) => sum + item.weight, 0)
      const weighted = group.reduce(
        (sum, item) => ({
          r: sum.r + item.color.r * item.weight,
          g: sum.g + item.color.g * item.weight,
          b: sum.b + item.color.b * item.weight,
        }),
        { r: 0, g: 0, b: 0 },
      )

      return {
        r: Math.round(weighted.r / totalWeight),
        g: Math.round(weighted.g / totalWeight),
        b: Math.round(weighted.b / totalWeight),
      }
    })
  }

  return centroids
}

const buildColorHistogram = (colors: Rgb[]) => {
  const histogram = new Map<string, WeightedColor>()

  for (const color of colors) {
    const key = `${Math.round(color.r / 10)}-${Math.round(color.g / 10)}-${Math.round(color.b / 10)}`
    const existing = histogram.get(key)
    if (existing) {
      existing.weight += 1
      existing.color = {
        r: Math.round((existing.color.r * (existing.weight - 1) + color.r) / existing.weight),
        g: Math.round((existing.color.g * (existing.weight - 1) + color.g) / existing.weight),
        b: Math.round((existing.color.b * (existing.weight - 1) + color.b) / existing.weight),
      }
    } else {
      histogram.set(key, { color: { ...color }, weight: 1 })
    }
  }

  return [...histogram.values()].sort((left, right) => right.weight - left.weight)
}

const paletteLabCache = new Map<string, Lab>()

const getPaletteLab = (color: PaletteColor) => {
  const cached = paletteLabCache.get(color.id)
  if (cached) {
    return cached
  }

  const lab = rgbToLab(hexToRgb(color.hex))
  paletteLabCache.set(color.id, lab)
  return lab
}

const findNearestPaletteColor = (target: Rgb, palette: PaletteColor[]) => {
  let winner = palette[0]
  let minDistance = Number.POSITIVE_INFINITY
  const targetLab = rgbToLab(target)

  for (const color of palette) {
    const distance = ciede2000(targetLab, getPaletteLab(color))
    if (distance < minDistance) {
      minDistance = distance
      winner = color
    }
  }

  return winner
}

const pickPaletteSubset = (colors: Rgb[], palette: PaletteColor[], colorLimit: number) => {
  const histogram = buildColorHistogram(colors)
  const centroids = clusterWeightedColors(
    histogram,
    Math.min(colorLimit, Math.max(1, Math.round(colorLimit * 1.35))),
  )

  const selected = new Map<string, PaletteColor>()

  centroids.forEach((centroid) => {
    const nearest = findNearestPaletteColor(centroid, palette)
    selected.set(nearest.id, nearest)
  })

  for (const entry of histogram) {
    if (selected.size >= colorLimit) {
      break
    }

    const nearest = findNearestPaletteColor(entry.color, palette)
    selected.set(nearest.id, nearest)
  }

  return [...selected.values()].slice(0, colorLimit)
}

const smoothIsolatedCells = (cells: Cell[]) => {
  const lookup = new Map(cells.map((cell) => [`${cell.x}-${cell.y}`, cell] as const))

  return cells.map((cell) => {
    const neighbors = [
      lookup.get(`${cell.x - 1}-${cell.y}`),
      lookup.get(`${cell.x + 1}-${cell.y}`),
      lookup.get(`${cell.x}-${cell.y - 1}`),
      lookup.get(`${cell.x}-${cell.y + 1}`),
    ].filter(Boolean) as Cell[]

    if (neighbors.length < 3) {
      return cell
    }

    const dominantNeighbor = neighbors.reduce<Record<string, number>>((acc, item) => {
      acc[item.color.id] = (acc[item.color.id] ?? 0) + 1
      return acc
    }, {})

    const [dominantColorId, count] =
      Object.entries(dominantNeighbor).sort((left, right) => right[1] - left[1])[0] ?? []

    if (!dominantColorId || dominantColorId === cell.color.id || count < 3) {
      return cell
    }

    const replacement = neighbors.find((neighbor) => neighbor.color.id === dominantColorId)

    return replacement ? { ...cell, color: replacement.color } : cell
  })
}

const buildGridFromImage = (
  image: HTMLImageElement,
  cols: number,
  rows: number,
  sourceMode: SourceMode,
  strategy: GenerationStrategy,
  preprocessPreset: PreprocessPreset,
) => {
  const sampleCanvas = document.createElement('canvas')
  sampleCanvas.width = cols
  sampleCanvas.height = rows
  const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true })

  if (!sampleContext) {
    throw new Error('无法创建采样画布')
  }

  sampleContext.clearRect(0, 0, cols, rows)
  sampleContext.imageSmoothingEnabled = sourceMode !== 'pattern'
  sampleContext.imageSmoothingQuality = sourceMode === 'pattern' ? 'low' : 'high'
  sampleContext.drawImage(image, 0, 0, cols, rows)
  const data = sampleContext.getImageData(0, 0, cols, rows).data
  const cells: Rgb[] = []

  for (let index = 0; index < data.length; index += 4) {
    const sampled = {
      r: data[index],
      g: data[index + 1],
      b: data[index + 2],
    }
    const preprocessed = sourceMode === 'pattern' ? sampled : preprocessColor(sampled, preprocessPreset)
    cells.push(sourceMode === 'pattern' ? preprocessed : applyGenerationStrategy(preprocessed, strategy))
  }

  return cells
}

const analyzeImageRecommendation = (image: HTMLImageElement): Recommendation => {
  const sampleWidth = 48
  const sampleHeight = Math.max(24, Math.round((image.height / image.width) * sampleWidth))
  const canvas = document.createElement('canvas')
  canvas.width = sampleWidth
  canvas.height = sampleHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })

  if (!context) {
    return {
      preprocessPreset: 'portrait',
      generationStrategy: 'accurate',
      ditherStrength: 72,
      gridSize: 48,
      colorLimit: 18,
      summary: '推荐了通用参数。',
    }
  }

  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, sampleWidth, sampleHeight)
  const data = context.getImageData(0, 0, sampleWidth, sampleHeight).data

  let totalSaturation = 0
  let totalLuma = 0
  let skinLike = 0
  let edgeEnergy = 0
  const bucketSet = new Set<string>()

  const getPixel = (x: number, y: number): Rgb => {
    const index = (y * sampleWidth + x) * 4
    return { r: data[index], g: data[index + 1], b: data[index + 2] }
  }

  for (let y = 0; y < sampleHeight; y += 1) {
    for (let x = 0; x < sampleWidth; x += 1) {
      const pixel = getPixel(x, y)
      const max = Math.max(pixel.r, pixel.g, pixel.b)
      const min = Math.min(pixel.r, pixel.g, pixel.b)
      const saturation = max === 0 ? 0 : (max - min) / max
      const luma = 0.299 * pixel.r + 0.587 * pixel.g + 0.114 * pixel.b

      totalSaturation += saturation
      totalLuma += luma
      bucketSet.add(`${Math.round(pixel.r / 32)}-${Math.round(pixel.g / 32)}-${Math.round(pixel.b / 32)}`)

      if (pixel.r > 95 && pixel.g > 40 && pixel.b > 20 && pixel.r > pixel.g && pixel.g > pixel.b) {
        skinLike += 1
      }

      if (x < sampleWidth - 1 && y < sampleHeight - 1) {
        const right = getPixel(x + 1, y)
        const bottom = getPixel(x, y + 1)
        edgeEnergy +=
          Math.abs(pixel.r - right.r) + Math.abs(pixel.g - right.g) + Math.abs(pixel.b - right.b)
        edgeEnergy +=
          Math.abs(pixel.r - bottom.r) + Math.abs(pixel.g - bottom.g) + Math.abs(pixel.b - bottom.b)
      }
    }
  }

  const pixelCount = sampleWidth * sampleHeight
  const avgSaturation = totalSaturation / pixelCount
  const avgLuma = totalLuma / pixelCount
  const detailScore = edgeEnergy / pixelCount
  const paletteSpread = bucketSet.size
  const skinRatio = skinLike / pixelCount
  const aspectRatio = image.height / image.width

  const preprocessPreset: PreprocessPreset =
    skinRatio > 0.18 ? 'portrait' : avgSaturation > 0.48 ? 'illustration' : 'landscape'

  const generationStrategy: GenerationStrategy =
    avgSaturation > 0.5 && detailScore < 90
      ? 'craft'
      : detailScore > 170 || paletteSpread > 26
        ? 'accurate'
        : 'reduced'

  const ditherStrength = clamp(
    Math.round(
      generationStrategy === 'accurate'
        ? 78 + Math.min(12, detailScore / 35) + (avgLuma < 96 ? 4 : 0)
        : generationStrategy === 'craft'
          ? 42 + avgSaturation * 24
          : 18 + detailScore / 18 - (avgLuma > 180 ? 4 : 0),
    ),
    0,
    100,
  )

  const gridSize = clamp(
    Math.round(
      aspectRatio > 1.25
        ? 44 + detailScore / 22
        : aspectRatio < 0.8
          ? 40 + detailScore / 24
          : 48 + detailScore / 20,
    ),
    28,
    72,
  )

  const colorLimit = clamp(
    Math.round(
      generationStrategy === 'reduced'
        ? 12 + paletteSpread / 3
        : generationStrategy === 'craft'
          ? 16 + paletteSpread / 2.8
          : 18 + paletteSpread / 2.2,
    ),
    8,
    36,
  )

  const presetLabel =
    preprocessPreset === 'portrait' ? '人像' : preprocessPreset === 'landscape' ? '风景' : '插画'
  const strategyLabel =
    generationStrategy === 'accurate'
      ? '最接近原图'
      : generationStrategy === 'reduced'
        ? '更少颜色'
        : '更适合拼豆'

  return {
    preprocessPreset,
    generationStrategy,
    ditherStrength,
    gridSize,
    colorLimit,
    summary: `推荐 ${presetLabel} + ${strategyLabel}，抖动 ${ditherStrength}，色数 ${colorLimit}。`,
  }
}

const applyErrorDiffusion = (
  colors: Rgb[],
  cols: number,
  rows: number,
  palette: PaletteColor[],
  strength: number,
) => {
  const working = colors.map((color) => ({ ...color }))
  const mapped: PaletteColor[] = Array.from({ length: colors.length })

  const diffuse = (index: number, error: Rgb, factor: number) => {
    if (index < 0 || index >= working.length) {
      return
    }

    working[index] = {
      r: clamp(Math.round(working[index].r + error.r * factor * strength), 0, 255),
      g: clamp(Math.round(working[index].g + error.g * factor * strength), 0, 255),
      b: clamp(Math.round(working[index].b + error.b * factor * strength), 0, 255),
    }
  }

  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const index = y * cols + x
      const adjusted = working[index]
      const nearest = findNearestPaletteColor(adjusted, palette)
      mapped[index] = nearest

      const nearestRgb = hexToRgb(nearest.hex)
      const error = subtractRgb(adjusted, nearestRgb)

      if (x + 1 < cols) {
        diffuse(index + 1, error, 7 / 16)
      }
      if (y + 1 < rows) {
        if (x > 0) {
          diffuse(index + cols - 1, error, 3 / 16)
        }
        diffuse(index + cols, error, 5 / 16)
        if (x + 1 < cols) {
          diffuse(index + cols + 1, error, 1 / 16)
        }
      }
    }
  }

  return mapped
}

const drawPatternCanvas = (
  result: PatternResult,
  options: {
    cellSize: number
    showCodes: boolean
    includeLegend: boolean
    highlightColorId?: string | null
    selectedCellKey?: string | null
  },
) => {
  const { cellSize, showCodes, includeLegend, highlightColorId, selectedCellKey } = options
  const legendWidth = includeLegend ? 280 : 0
  const padding = 24
  const canvas = document.createElement('canvas')
  canvas.width = result.cols * cellSize + padding * 2 + legendWidth
  canvas.height = result.rows * cellSize + padding * 2
  const context = canvas.getContext('2d')

  if (!context) {
    throw new Error('无法生成图纸画布')
  }

  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.translate(padding, padding)

  for (const cell of result.cells) {
    const isDimmed = highlightColorId ? cell.color.id !== highlightColorId : false
    context.globalAlpha = isDimmed ? 0.16 : 1
    context.fillStyle = cell.color.hex
    context.fillRect(cell.x * cellSize, cell.y * cellSize, cellSize, cellSize)
    context.strokeStyle = 'rgba(31, 41, 55, 0.16)'
    context.strokeRect(cell.x * cellSize, cell.y * cellSize, cellSize, cellSize)
    context.globalAlpha = 1

    if (showCodes && cellSize >= 18) {
      context.fillStyle = isDimmed ? 'rgba(17, 24, 39, 0.35)' : '#111827'
      context.font = `${Math.floor(cellSize * 0.33)}px ui-monospace, SFMono-Regular, monospace`
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(cell.color.code, cell.x * cellSize + cellSize / 2, cell.y * cellSize + cellSize / 2)
    }

    if (selectedCellKey === `${cell.x}-${cell.y}`) {
      context.strokeStyle = '#111827'
      context.lineWidth = Math.max(2, Math.floor(cellSize * 0.08))
      context.strokeRect(
        cell.x * cellSize + 1,
        cell.y * cellSize + 1,
        cellSize - 2,
        cellSize - 2,
      )
      context.lineWidth = 1
    }
  }

  if (includeLegend) {
    const legendX = result.cols * cellSize + 40
    context.textAlign = 'left'
    context.textBaseline = 'top'
    context.fillStyle = '#111827'
    context.font = '600 20px ui-sans-serif, system-ui, sans-serif'
    context.fillText('颜色图例', legendX, 0)

    result.legend.forEach((item, index) => {
      const top = 42 + index * 28
      context.fillStyle = item.color.hex
      context.fillRect(legendX, top, 18, 18)
      context.strokeStyle = 'rgba(17, 24, 39, 0.15)'
      context.strokeRect(legendX, top, 18, 18)
      context.fillStyle = '#374151'
      context.font = '14px ui-sans-serif, system-ui, sans-serif'
      context.fillText(`${item.color.code}  ${item.color.hex}  x ${item.count}`, legendX + 28, top + 1)
    })
  }

  return canvas
}

const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片加载失败'))
    image.src = url
  })

const blobUrlToDataUrl = async (blobUrl: string) => {
  const response = await fetch(blobUrl)
  const blob = await response.blob()

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('图片读取失败'))
      }
    }
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(blob)
  })
}

const buildLegendFromCells = (cells: Cell[]) => {
  const counts = new Map<string, number>()
  cells.forEach((cell) => {
    counts.set(cell.color.id, (counts.get(cell.color.id) ?? 0) + 1)
  })

  return [...counts.entries()]
    .map(([id, count]) => ({
      color: beadPalette.find((item) => item.id === id)!,
      count,
    }))
    .sort((left, right) => right.count - left.count)
}

const snapshotFromPattern = (pattern: PatternResult): PatternSnapshot => ({
  rows: pattern.rows,
  cols: pattern.cols,
  cells: pattern.cells.map((cell) => ({ ...cell, color: cell.color })),
})

const patternFromSnapshot = (
  snapshot: PatternSnapshot,
  previousPreviewDataUrl = '',
): PatternResult => ({
  rows: snapshot.rows,
  cols: snapshot.cols,
  cells: snapshot.cells.map((cell) => ({ ...cell, color: cell.color })),
  legend: buildLegendFromCells(snapshot.cells),
  previewDataUrl: previousPreviewDataUrl,
})

function App() {
  const storageKey = 'pindou-editor-state'
  const uploadInputId = 'source-image-upload'
  const [sourceMode, setSourceMode] = useState<SourceMode>('photo')
  const [generationStrategy, setGenerationStrategy] = useState<GenerationStrategy>('accurate')
  const [preprocessPreset, setPreprocessPreset] = useState<PreprocessPreset>('portrait')
  const [ditherStrength, setDitherStrength] = useState(72)
  const [gridSize, setGridSize] = useState(48)
  const [colorLimit, setColorLimit] = useState(18)
  const [mergeSensitivity, setMergeSensitivity] = useState(26)
  const [sourceImage, setSourceImage] = useState<string | null>(null)
  const [sourceFileName, setSourceFileName] = useState('未上传图片')
  const [pattern, setPattern] = useState<PatternResult | null>(null)
  const [activeColorIds, setActiveColorIds] = useState<string[]>(beadPalette.map((item) => item.id))
  const [zoom, setZoom] = useState(1)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isRecommending, setIsRecommending] = useState(false)
  const [isAiRecommending, setIsAiRecommending] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [recommendationSummary, setRecommendationSummary] = useState('')
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)
  const [paletteGroup, setPaletteGroup] = useState<'all' | string>('all')
  const [isDragging, setIsDragging] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [isPaletteCollapsed, setIsPaletteCollapsed] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= 1180,
  )
  const [highlightColorId, setHighlightColorId] = useState<string | null>(null)
  const [selectedCellKey, setSelectedCellKey] = useState<string | null>(null)
  const [currentPaintColorId, setCurrentPaintColorId] = useState<string | null>(null)
  const [editMode, setEditMode] = useState<EditMode>('inspect')
  const [replaceState, setReplaceState] = useState<ReplaceState>({ fromId: '', toId: '' })
  const [undoStack, setUndoStack] = useState<PatternSnapshot[]>([])
  const [redoStack, setRedoStack] = useState<PatternSnapshot[]>([])
  const boardCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const previewSectionRef = useRef<HTMLDivElement | null>(null)
  const boardMetricsRef = useRef<CanvasMetrics>({ cellSize: 18, padding: 24 })
  const interactionRef = useRef<{ isDrawing: boolean; startKey: string | null }>({
    isDrawing: false,
    startKey: null,
  })

  const enabledPalette = useMemo(() => {
    const selected = beadPalette.filter((item) => activeColorIds.includes(item.id))
    return selected.length > 1 ? selected : beadPalette
  }, [activeColorIds])

  const paletteGroups = useMemo(
    () => ['all', ...new Set(beadPalette.map((item) => item.group))],
    [],
  )

  const visiblePalette = useMemo(
    () =>
      beadPalette.filter((item) =>
        paletteGroup === 'all' ? true : item.group === paletteGroup,
      ),
    [paletteGroup],
  )

  const palettePreviewColors = useMemo(() => {
    if (pattern?.legend.length) {
      return pattern.legend.slice(0, 6).map((item) => item.color)
    }

    return enabledPalette.slice(0, 6)
  }, [enabledPalette, pattern])

  const commitPattern = (nextPattern: PatternResult, options?: { skipHistory?: boolean }) => {
    if (!options?.skipHistory && pattern) {
      setUndoStack((current) => [...current, snapshotFromPattern(pattern)].slice(-50))
      setRedoStack([])
    }
    setPattern(nextPattern)
  }

  useEffect(() => {
    if (!pattern) {
      return
    }

    const renderToCanvas = (
      target: HTMLCanvasElement | null,
      cellSize: number,
      showCodes: boolean,
    ) => {
      if (!target) {
        return
      }

      const canvas = drawPatternCanvas(pattern, {
        cellSize,
        showCodes,
        includeLegend: false,
        highlightColorId,
        selectedCellKey,
      })

      target.width = canvas.width
      target.height = canvas.height

      const context = target.getContext('2d')
      if (!context) {
        return
      }

      context.clearRect(0, 0, target.width, target.height)
      context.drawImage(canvas, 0, 0)
    }

    const boardCellSize = Math.max(14, Math.floor(18 * zoom))
    boardMetricsRef.current = { cellSize: boardCellSize, padding: 24 }

    renderToCanvas(boardCanvasRef.current, boardCellSize, false)
    renderToCanvas(previewCanvasRef.current, Math.max(12, Math.floor(26 * zoom)), true)
  }, [pattern, zoom, highlightColorId, selectedCellKey])

  useEffect(() => {
    return () => {
      if (sourceImage) {
        URL.revokeObjectURL(sourceImage)
      }
    }
  }, [sourceImage])

  useEffect(() => {
    if (!sourceImage || typeof window === 'undefined' || window.innerWidth > 820) {
      return
    }

    window.requestAnimationFrame(() => {
      const uploadPreview = document.getElementById('upload-preview-card')
      uploadPreview?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
  }, [sourceImage])

  useEffect(() => {
    if (!pattern || typeof window === 'undefined' || window.innerWidth > 820) {
      return
    }

    window.requestAnimationFrame(() => {
      previewSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [pattern])

  useEffect(() => {
    if (!pattern?.legend.length) {
      return
    }

    setReplaceState((current) => ({
      fromId: current.fromId || pattern.legend[0]?.color.id || '',
      toId:
        current.toId ||
        pattern.legend.find((item) => item.color.id !== (current.fromId || pattern.legend[0]?.color.id))?.color.id ||
        pattern.legend[0]?.color.id ||
        '',
    }))
  }, [pattern])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const raw = window.localStorage.getItem(storageKey)
    if (!raw) {
      return
    }

    try {
      const parsed = JSON.parse(raw) as {
        pattern?: PatternSnapshot
        undoStack?: PatternSnapshot[]
        redoStack?: PatternSnapshot[]
        sourceFileName?: string
      }

      if (parsed.pattern) {
        setPattern(patternFromSnapshot(parsed.pattern))
      }
      if (parsed.undoStack) {
        setUndoStack(parsed.undoStack)
      }
      if (parsed.redoStack) {
        setRedoStack(parsed.redoStack)
      }
      if (parsed.sourceFileName) {
        setSourceFileName(parsed.sourceFileName)
      }
    } catch {
      window.localStorage.removeItem(storageKey)
    }
  }, [storageKey])

  useEffect(() => {
    if (typeof window === 'undefined' || !pattern) {
      return
    }

    const payload = JSON.stringify({
      pattern: snapshotFromPattern(pattern),
      undoStack,
      redoStack,
      sourceFileName,
    })

    window.localStorage.setItem(storageKey, payload)
  }, [pattern, redoStack, sourceFileName, storageKey, undoStack])

  const handleSelectedFile = (file?: File) => {
    if (!file) {
      return
    }

    if (sourceImage) {
      URL.revokeObjectURL(sourceImage)
    }

    setErrorMessage('')
    setRecommendationSummary('')
    setSourceFileName(file.name)
    setPattern(null)
    setHighlightColorId(null)
    setSelectedCellKey(null)
    setSourceImage(URL.createObjectURL(file))
  }

  const handleRecommendParams = async () => {
    if (!sourceImage) {
      setErrorMessage('请先上传图片。')
      return
    }

    setIsRecommending(true)
    setErrorMessage('')

    try {
      const image = await loadImage(sourceImage)
      const recommendation = analyzeImageRecommendation(image)

      startTransition(() => {
        setPreprocessPreset(recommendation.preprocessPreset)
        setGenerationStrategy(recommendation.generationStrategy)
        setDitherStrength(recommendation.ditherStrength)
        setGridSize(recommendation.gridSize)
        setColorLimit(recommendation.colorLimit)
        setShowAdvanced(true)
        setRecommendationSummary(recommendation.summary)
      })
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '推荐参数失败，请稍后重试。')
    } finally {
      setIsRecommending(false)
    }
  }

  const handleAiRecommendParams = async () => {
    if (!sourceImage) {
      setErrorMessage('请先上传图片。')
      return
    }

    setIsAiRecommending(true)
    setErrorMessage('')

    try {
      const imageDataUrl = await blobUrlToDataUrl(sourceImage)
      const response = await fetch('/api/ai-recommend', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          imageDataUrl,
          filename: sourceFileName,
          localRecommendation: recommendationSummary || undefined,
        }),
      })

      const result = (await response.json()) as RecommendationApiResult | { error?: string }

      if (!response.ok) {
        throw new Error('error' in result && result.error ? result.error : 'AI 推荐失败。')
      }

      const recommendation = result as RecommendationApiResult

      startTransition(() => {
        setPreprocessPreset(recommendation.preprocessPreset)
        setGenerationStrategy(recommendation.generationStrategy)
        setDitherStrength(recommendation.ditherStrength)
        setGridSize(recommendation.gridSize)
        setColorLimit(recommendation.colorLimit)
        setShowAdvanced(true)
        setRecommendationSummary(recommendation.summary)
      })
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'AI 推荐失败，请稍后重试。')
    } finally {
      setIsAiRecommending(false)
    }
  }

  const handleUpload = (event: ChangeEvent<HTMLInputElement>) => {
    handleSelectedFile(event.target.files?.[0])
  }

  const handleDragEnter = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    setIsDragging(true)
  }

  const handleDragOver = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return
    }
    setIsDragging(false)
  }

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    setIsDragging(false)
    handleSelectedFile(event.dataTransfer.files?.[0])
  }

  const toggleColor = (id: string) => {
    setActiveColorIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
  }

  const toggleHighlight = (colorId: string) => {
    setHighlightColorId((current) => (current === colorId ? null : colorId))
  }

  const getCanvasCell = (event: MouseEvent<HTMLCanvasElement>) => {
    if (!pattern || !boardCanvasRef.current) {
      return null
    }

    const rect = boardCanvasRef.current.getBoundingClientRect()
    const scaleX = boardCanvasRef.current.width / rect.width
    const scaleY = boardCanvasRef.current.height / rect.height
    const x = (event.clientX - rect.left) * scaleX
    const y = (event.clientY - rect.top) * scaleY
    const { cellSize, padding } = boardMetricsRef.current
    const cellX = Math.floor((x - padding) / cellSize)
    const cellY = Math.floor((y - padding) / cellSize)

    if (cellX < 0 || cellY < 0 || cellX >= pattern.cols || cellY >= pattern.rows) {
      return null
    }

    return { x: cellX, y: cellY, key: `${cellX}-${cellY}` }
  }

  const applyPaintToCells = (cellKeys: string[]) => {
    if (!pattern || !currentPaintColorId) {
      return
    }

    const paintColor = beadPalette.find((item) => item.id === currentPaintColorId)
    if (!paintColor) {
      return
    }

    const keySet = new Set(cellKeys)
    const cells = pattern.cells.map((cell) =>
      keySet.has(`${cell.x}-${cell.y}`) ? { ...cell, color: paintColor } : cell,
    )

    commitPattern({
      ...pattern,
      cells,
      legend: buildLegendFromCells(cells),
    })
    setHighlightColorId(paintColor.id)
  }

  const handleBoardCanvasClick = (event: MouseEvent<HTMLCanvasElement>) => {
    const hit = getCanvasCell(event)
    if (!hit || !pattern) {
      return
    }

    const cell = pattern.cells.find((item) => item.x === hit.x && item.y === hit.y)
    if (!cell) {
      return
    }

    if (editMode === 'paint' && currentPaintColorId) {
      applyPaintToCells([hit.key])
    } else {
      setSelectedCellKey(hit.key)
      setHighlightColorId(cell.color.id)
    }
  }

  const handleBoardMouseDown = (event: MouseEvent<HTMLCanvasElement>) => {
    const hit = getCanvasCell(event)
    if (!hit) {
      return
    }

    interactionRef.current = { isDrawing: true, startKey: hit.key }

    if (editMode === 'paint' && currentPaintColorId) {
      applyPaintToCells([hit.key])
      setSelectedCellKey(hit.key)
    }
  }

  const handleBoardMouseMove = (event: MouseEvent<HTMLCanvasElement>) => {
    if (!interactionRef.current.isDrawing || editMode !== 'paint' || !currentPaintColorId) {
      return
    }

    const hit = getCanvasCell(event)
    if (!hit) {
      return
    }

    applyPaintToCells([hit.key])
    setSelectedCellKey(hit.key)
  }

  const handleBoardMouseUp = (event: MouseEvent<HTMLCanvasElement>) => {
    if (!interactionRef.current.isDrawing || editMode !== 'box' || !pattern || !currentPaintColorId) {
      interactionRef.current = { isDrawing: false, startKey: null }
      return
    }

    const hit = getCanvasCell(event)
    const startKey = interactionRef.current.startKey
    interactionRef.current = { isDrawing: false, startKey: null }

    if (!hit || !startKey) {
      return
    }

    const [startX, startY] = startKey.split('-').map(Number)
    const minX = Math.min(startX, hit.x)
    const maxX = Math.max(startX, hit.x)
    const minY = Math.min(startY, hit.y)
    const maxY = Math.max(startY, hit.y)
    const keys: string[] = []

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        keys.push(`${x}-${y}`)
      }
    }

    applyPaintToCells(keys)
    setSelectedCellKey(hit.key)
  }

  const handleReplaceColors = () => {
    if (!pattern || !replaceState.fromId || !replaceState.toId || replaceState.fromId === replaceState.toId) {
      return
    }

    const targetColor = beadPalette.find((item) => item.id === replaceState.toId)
    if (!targetColor) {
      return
    }

    const cells = pattern.cells.map((cell) =>
      cell.color.id === replaceState.fromId ? { ...cell, color: targetColor } : cell,
    )

    commitPattern({
      ...pattern,
      cells,
      legend: buildLegendFromCells(cells),
    })
    setHighlightColorId(targetColor.id)
    setCurrentPaintColorId(targetColor.id)
  }

  const handleUndo = () => {
    if (!pattern || undoStack.length === 0) {
      return
    }

    const previous = undoStack[undoStack.length - 1]
    setUndoStack((current) => current.slice(0, -1))
    setRedoStack((current) => [...current, snapshotFromPattern(pattern)].slice(-50))
    setPattern(patternFromSnapshot(previous, pattern.previewDataUrl))
  }

  const handleRedo = () => {
    if (!pattern || redoStack.length === 0) {
      return
    }

    const next = redoStack[redoStack.length - 1]
    setRedoStack((current) => current.slice(0, -1))
    setUndoStack((current) => [...current, snapshotFromPattern(pattern)].slice(-50))
    setPattern(patternFromSnapshot(next, pattern.previewDataUrl))
  }

  const handleGenerate = async () => {
    if (!sourceImage) {
      setErrorMessage('请先上传图片。')
      return
    }

    setIsGenerating(true)
    setErrorMessage('')

    try {
      const image = await loadImage(sourceImage)
      const aspectRatio = image.height / image.width
      const cols = gridSize
      const rows = Math.max(1, Math.round(gridSize * aspectRatio))
      const sampledGrid = buildGridFromImage(
        image,
        cols,
        rows,
        sourceMode,
        generationStrategy,
        preprocessPreset,
      )

      const paletteTargetSize = Math.min(
        colorLimit,
        generationStrategy === 'reduced'
          ? Math.max(4, Math.round(colorLimit * 0.82))
          : generationStrategy === 'craft'
            ? Math.max(4, Math.round(colorLimit * 0.9))
            : colorLimit,
        enabledPalette.length,
      )

      const paletteToUse =
        sourceMode === 'pattern'
          ? enabledPalette
          : pickPaletteSubset(sampledGrid, enabledPalette, paletteTargetSize)

      const mappedPaletteColors =
        sourceMode === 'pattern'
          ? sampledGrid.map((color) => findNearestPaletteColor(color, paletteToUse))
          : generationStrategy === 'reduced'
            ? sampledGrid.map((color) => findNearestPaletteColor(color, paletteToUse))
            : applyErrorDiffusion(
                sampledGrid,
                cols,
                rows,
                paletteToUse,
                (ditherStrength / 100) * (generationStrategy === 'accurate' ? 0.88 : 0.42),
              )

      const cells = mappedPaletteColors.map((mappedColor, index) => ({
        x: index % cols,
        y: Math.floor(index / cols),
        color: mappedColor,
      }))

      const normalizedCells = generationStrategy === 'craft' ? smoothIsolatedCells(cells) : cells

      const previewCanvas = drawPatternCanvas(
        {
          rows,
          cols,
          cells: normalizedCells,
          legend: [],
          previewDataUrl: '',
        },
        { cellSize: 18, showCodes: false, includeLegend: false },
      )

      const legend = buildLegendFromCells(normalizedCells)

      startTransition(() => {
        setHighlightColorId(null)
        setSelectedCellKey(null)
        setZoom(typeof window !== 'undefined' && window.innerWidth <= 820 ? 0.78 : 1)
        setCurrentPaintColorId(legend[0]?.color.id ?? null)
        setReplaceState({
          fromId: legend[0]?.color.id ?? '',
          toId: legend[1]?.color.id ?? legend[0]?.color.id ?? '',
        })
        setUndoStack([])
        setRedoStack([])
        setPattern({
          rows,
          cols,
          cells: normalizedCells,
          legend: buildLegendFromCells(normalizedCells),
          previewDataUrl: previewCanvas.toDataURL('image/png'),
        })
      })
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '生成失败，请稍后重试。')
    } finally {
      setIsGenerating(false)
    }
  }

  const downloadPattern = () => {
    if (!pattern) {
      return
    }

    const canvas = drawPatternCanvas(pattern, {
      cellSize: 28,
      showCodes: true,
      includeLegend: true,
    })

    const link = document.createElement('a')
    link.href = canvas.toDataURL('image/png')
    link.download = `${sourceFileName.replace(/\.[^/.]+$/, '') || 'pindou'}-pattern.png`
    link.click()
  }

  const totalBeads = pattern?.cells.length ?? 0
  const selectedCell =
    pattern && selectedCellKey
      ? pattern.cells.find((cell) => `${cell.x}-${cell.y}` === selectedCellKey) ?? null
      : null

  return (
    <div className="app-shell">
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">MARD 221 色号拼豆工具</span>
          <h1>上传图片，按 MARD 色号生成拼豆图纸</h1>
          <div className="hero-actions">
            <button className="primary-button" onClick={handleGenerate} disabled={isGenerating || !sourceImage}>
              {isGenerating ? '生成中...' : '生成拼豆图案'}
            </button>
            <button className="secondary-button" onClick={() => setIsPreviewOpen(true)} disabled={!pattern}>
              查看大图
            </button>
          </div>
          <div className="hero-stats">
            <div>
              <strong>{pattern?.cols ?? gridSize}</strong>
              <span>网格宽度</span>
            </div>
            <div>
              <strong>{pattern?.rows ?? '--'}</strong>
              <span>网格高度</span>
            </div>
            <div>
              <strong>{pattern?.legend.length ?? 0}</strong>
              <span>MARD 色号</span>
            </div>
            <div>
              <strong>{totalBeads}</strong>
              <span>拼豆颗数</span>
            </div>
          </div>
        </div>

        <div className="hero-card">
          <div className="card-header">
            <span>上传与生成</span>
            <div className="mode-switch">
              <button
                className={sourceMode === 'photo' ? 'chip active' : 'chip'}
                onClick={() => setSourceMode('photo')}
              >
                普通图片
              </button>
              <button
                className={sourceMode === 'pattern' ? 'chip active' : 'chip'}
                onClick={() => setSourceMode('pattern')}
              >
                已有图纸
              </button>
            </div>
          </div>

          <div className="system-banner">
            <strong>色号系统</strong>
            <span>MARD 221 色</span>
          </div>

          <label
            className={isDragging ? 'upload-panel dragging' : 'upload-panel'}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <input id={uploadInputId} type="file" accept="image/*" onChange={handleUpload} />
            <span>拖放图片到此处</span>
            <small>或点击选择文件，支持 JPG / PNG</small>
          </label>

          {sourceImage ? (
            <div className="upload-preview-card" id="upload-preview-card">
              <img src={sourceImage} alt="已上传图片预览" />
              <div>
                <strong>已上传图片</strong>
                <small>{sourceFileName}</small>
              </div>
            </div>
          ) : null}

          <div className="flow-note">先选图片类型，再调抖动强度。抖动更高更接近原图，抖动更低画面会更干净。</div>

          <div className="recommend-row">
            <div className="recommend-actions">
              <button
                className="secondary-button"
                onClick={handleRecommendParams}
                disabled={!sourceImage || isRecommending}
              >
                {isRecommending ? '分析中...' : '一键推荐参数'}
              </button>
              <button
                className="primary-button"
                onClick={handleAiRecommendParams}
                disabled={!sourceImage || isAiRecommending}
              >
                {isAiRecommending ? 'AI 分析中...' : 'AI 推荐参数'}
              </button>
            </div>
            <small>AI 推荐需要服务端配置 `OPENAI_API_KEY`，会比本地规则更细。</small>
          </div>

          {recommendationSummary ? <div className="recommend-note">{recommendationSummary}</div> : null}

          <div className="control-grid">
            <label>
              <span>图纸宽度: {gridSize}</span>
              <input
                type="range"
                min="16"
                max="96"
                value={gridSize}
                onChange={(event) => setGridSize(Number(event.target.value))}
              />
            </label>
            <label>
              <span>最大颜色数: {colorLimit}</span>
              <input
                type="range"
                min="6"
                max="72"
                value={colorLimit}
                onChange={(event) => setColorLimit(Number(event.target.value))}
              />
            </label>
          </div>

          <button
            className={showAdvanced ? 'advanced-toggle active' : 'advanced-toggle'}
            onClick={() => setShowAdvanced((current) => !current)}
          >
            <span>高级设置</span>
            <strong>{showAdvanced ? '收起' : '展开'}</strong>
          </button>

          {showAdvanced ? (
            <div className="advanced-panel">
              <div className="processing-modes">
                <button
                  className={preprocessPreset === 'portrait' ? 'chip active' : 'chip'}
                  onClick={() => setPreprocessPreset('portrait')}
                >
                  人像
                </button>
                <button
                  className={preprocessPreset === 'landscape' ? 'chip active' : 'chip'}
                  onClick={() => setPreprocessPreset('landscape')}
                >
                  风景
                </button>
                <button
                  className={preprocessPreset === 'illustration' ? 'chip active' : 'chip'}
                  onClick={() => setPreprocessPreset('illustration')}
                >
                  插画
                </button>
              </div>
              <div className="processing-modes">
                <button
                  className={generationStrategy === 'accurate' ? 'chip active' : 'chip'}
                  onClick={() => setGenerationStrategy('accurate')}
                >
                  最接近原图
                </button>
                <button
                  className={generationStrategy === 'reduced' ? 'chip active' : 'chip'}
                  onClick={() => setGenerationStrategy('reduced')}
                >
                  更少颜色
                </button>
                <button
                  className={generationStrategy === 'craft' ? 'chip active' : 'chip'}
                  onClick={() => setGenerationStrategy('craft')}
                >
                  更适合拼豆
                </button>
              </div>
              <div className="control-grid">
                <label>
                  <span>抖动强度: {ditherStrength}</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={ditherStrength}
                    onChange={(event) => setDitherStrength(Number(event.target.value))}
                  />
                </label>
                <label>
                  <span>合并敏感度: {mergeSensitivity}</span>
                  <input
                    type="range"
                    min="0"
                    max="60"
                    value={mergeSensitivity}
                    onChange={(event) => setMergeSensitivity(Number(event.target.value))}
                  />
                </label>
              </div>
            </div>
          ) : null}

          {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
        </div>
      </section>

      <section className="workspace">
        <div className={isPaletteCollapsed ? 'panel workspace-sidebar collapsed' : 'panel workspace-sidebar'}>
          <div className="panel-top palette-top">
            <div>
              <h2>色卡工具箱</h2>
              <span>{currentPaintColorId ? `画笔 ${beadPalette.find((item) => item.id === currentPaintColorId)?.code}` : `${enabledPalette.length} / 221`}</span>
            </div>
            <button
              className={isPaletteCollapsed ? 'palette-toggle collapsed' : 'palette-toggle'}
              onClick={() => setIsPaletteCollapsed((current) => !current)}
            >
              {isPaletteCollapsed ? '展开色号' : '收起色号'}
            </button>
          </div>
          <div className="palette-summary">
            <div className="palette-summary-copy">
              <strong>MARD 221</strong>
              <small>{pattern ? `当前图纸用了 ${pattern.legend.length} 个色号` : '先生成图案，再挑色号和改色。'}</small>
            </div>
            <div className="palette-preview-row">
              {palettePreviewColors.map((color) => (
                <span key={color.id} style={{ backgroundColor: color.hex }} title={color.code} />
              ))}
            </div>
          </div>
          <div className="editor-tools">
            <button
              className={editMode === 'inspect' ? 'editor-tool active' : 'editor-tool'}
              onClick={() => setEditMode('inspect')}
            >
              查看
            </button>
            <button
              className={editMode === 'paint' ? 'editor-tool active' : 'editor-tool'}
              onClick={() => setEditMode('paint')}
            >
              涂改
            </button>
            <button
              className={editMode === 'box' ? 'editor-tool active' : 'editor-tool'}
              onClick={() => setEditMode('box')}
            >
              框选
            </button>
          </div>
          {isPaletteCollapsed ? (
            <div className="palette-collapsed-note">
              <span>色号面板已收起，保留当前画笔和编辑工具。</span>
              <small>需要筛选或选色时再展开。</small>
            </div>
          ) : (
            <>
              <div className="group-tabs">
                {paletteGroups.map((group) => (
                  <button
                    key={group}
                    className={paletteGroup === group ? 'group-tab active' : 'group-tab'}
                    onClick={() => setPaletteGroup(group)}
                  >
                    {group === 'all' ? '全部' : group}
                  </button>
                ))}
              </div>
              <div className="palette-grid">
                {visiblePalette.map((color) => {
                  const active = activeColorIds.includes(color.id)
                  const selected = currentPaintColorId === color.id
                  const highlighted = highlightColorId === color.id
                  return (
                    <button
                      key={color.id}
                      className={
                        selected
                          ? 'palette-swatch selected'
                          : highlighted
                            ? 'palette-swatch highlighted'
                            : active
                              ? 'palette-swatch active'
                              : 'palette-swatch'
                      }
                      onClick={() => {
                        setCurrentPaintColorId(color.id)
                        setHighlightColorId(color.id)
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        toggleColor(color.id)
                      }}
                      title={color.name}
                    >
                      <span style={{ backgroundColor: color.hex }} />
                      <div className="palette-copy">
                        <strong>{color.code}</strong>
                        <small>{color.hex}</small>
                      </div>
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>

        <div className="panel preview-panel workspace-main" ref={previewSectionRef}>
          <div className="panel-top">
            <h2>效果展示</h2>
            <div className="preview-actions">
              <button className="ghost-button" onClick={() => setZoom((current) => clamp(current - 0.2, 0.6, 3))} disabled={!pattern}>
                缩小
              </button>
              <button className="ghost-button" onClick={() => setZoom((current) => clamp(current + 0.2, 0.6, 3))} disabled={!pattern}>
                放大
              </button>
              <button className="ghost-button" onClick={() => setIsPreviewOpen(true)} disabled={!pattern}>
                全屏
              </button>
            </div>
          </div>

          <div className="workbench-toolbar">
            <span>{editMode === 'inspect' ? '查看模式' : editMode === 'paint' ? '涂改模式' : '框选模式'}</span>
            <span>MARD 221</span>
            <span>{preprocessPreset === 'portrait' ? '人像预处理' : preprocessPreset === 'landscape' ? '风景预处理' : '插画预处理'}</span>
            <span>{generationStrategy === 'accurate' ? '最接近原图' : generationStrategy === 'reduced' ? '更少颜色' : '更适合拼豆'}</span>
            <span>抖动 {ditherStrength}</span>
            <span>{pattern?.legend.length ?? 0} 色</span>
            <span>{Math.round(zoom * 100)}%</span>
            <span>自动保存</span>
            <button className="toolbar-clear" onClick={handleUndo} disabled={undoStack.length === 0}>
              撤销
            </button>
            <button className="toolbar-clear" onClick={handleRedo} disabled={redoStack.length === 0}>
              重做
            </button>
            {highlightColorId ? (
              <button className="toolbar-clear" onClick={() => setHighlightColorId(null)}>
                清除筛选
              </button>
            ) : null}
          </div>

          <div className="compare-note">
            <span>原图</span>
            <span>自动量化</span>
            <span>MARD 对照</span>
          </div>

          <div className="preview-grid workbench-grid">
            <div className="image-card">
              <h3>原图</h3>
              {sourceImage ? <img src={sourceImage} alt="原图" /> : <div className="empty-state">等待上传图片</div>}
            </div>
            <div className="image-card">
              <h3>生成拼豆</h3>
              {pattern ? (
                <div className="canvas-panel">
                  <canvas
                    ref={boardCanvasRef}
                    onClick={handleBoardCanvasClick}
                    onMouseDown={handleBoardMouseDown}
                    onMouseMove={handleBoardMouseMove}
                    onMouseUp={handleBoardMouseUp}
                    onMouseLeave={handleBoardMouseUp}
                  />
                </div>
              ) : (
                <div className="empty-state">点击“生成拼豆图案”</div>
              )}
            </div>
          </div>

          <div className="inspector-panel">
            {selectedCell ? (
              <>
                <div className="inspector-swatch" style={{ backgroundColor: selectedCell.color.hex }} />
                <div>
                  <strong>{selectedCell.color.code}</strong>
                  <small>
                    第 {selectedCell.y + 1} 行 / 第 {selectedCell.x + 1} 列
                  </small>
                </div>
                <em>{selectedCell.color.hex}</em>
              </>
            ) : (
              <span>{editMode === 'box' ? '拖拽生成图中的区域，可批量改成当前画笔颜色。' : editMode === 'paint' ? '点击或拖动生成图中的格子，可直接改色。' : '点击生成图中的任意格子，查看对应 MARD 色号。'}</span>
            )}
          </div>
        </div>

        <div className="panel workspace-aside">
          <div className="panel-top">
            <h2>MARD 对照清单</h2>
            <button className="primary-button" onClick={downloadPattern} disabled={!pattern}>
              导出图案
            </button>
          </div>
          {pattern?.legend.length ? (
            <div className="replace-panel">
              <select
                value={replaceState.fromId}
                onChange={(event) => setReplaceState((current) => ({ ...current, fromId: event.target.value }))}
              >
                {pattern.legend.map((item) => (
                  <option key={`from-${item.color.id}`} value={item.color.id}>
                    替换 {item.color.code}
                  </option>
                ))}
              </select>
              <select
                value={replaceState.toId}
                onChange={(event) => setReplaceState((current) => ({ ...current, toId: event.target.value }))}
              >
                {pattern.legend.map((item) => (
                  <option key={`to-${item.color.id}`} value={item.color.id}>
                    为 {item.color.code}
                  </option>
                ))}
              </select>
              <button className="ghost-button" onClick={handleReplaceColors}>
                全局替换
              </button>
            </div>
          ) : null}
          <div className="legend-list">
            {pattern?.legend.length ? (
              pattern.legend.map((item) => (
                <button
                  className={highlightColorId === item.color.id ? 'legend-item active' : 'legend-item'}
                  key={item.color.id}
                  onClick={() => toggleHighlight(item.color.id)}
                >
                  <span className="legend-color" style={{ backgroundColor: item.color.hex }} />
                  <div>
                    <strong>{item.color.code}</strong>
                    <small>{item.color.hex}</small>
                  </div>
                  <em>x {item.count}</em>
                </button>
              ))
            ) : (
              <div className="empty-state compact">生成后显示颜色统计和用量。</div>
            )}
          </div>
        </div>
      </section>

      <div className="mobile-action-bar">
        <label className="secondary-button mobile-upload-button" htmlFor={uploadInputId}>
          {sourceImage ? '更换图片' : '上传图片'}
        </label>
        <button className="primary-button mobile-generate-button" onClick={handleGenerate} disabled={isGenerating || !sourceImage}>
          {isGenerating ? '生成中...' : '生成图案'}
        </button>
      </div>

      {isPreviewOpen && pattern ? (
        <div className="lightbox" onClick={() => setIsPreviewOpen(false)}>
          <div className="lightbox-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="panel-top">
              <h2>图纸全屏预览</h2>
              <button className="ghost-button" onClick={() => setIsPreviewOpen(false)}>
                关闭
              </button>
            </div>
            <div className="lightbox-toolbar">
              <button className="ghost-button" onClick={() => setZoom((current) => clamp(current - 0.2, 0.6, 3))}>
                缩小
              </button>
              <button className="ghost-button" onClick={() => setZoom((current) => clamp(current + 0.2, 0.6, 3))}>
                放大
              </button>
              <button className="primary-button" onClick={downloadPattern}>
                下载图纸
              </button>
            </div>
            <div className="canvas-wrap">
              <canvas ref={previewCanvasRef} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default App
