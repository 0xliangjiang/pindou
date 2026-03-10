import { useEffect, useMemo, useRef, useState, startTransition } from 'react'
import type { ChangeEvent } from 'react'
import './App.css'
import { beadPalette, type PaletteColor } from './palette'

type SourceMode = 'photo' | 'pattern'

type Rgb = {
  r: number
  g: number
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

const colorDistance = (a: Rgb, b: Rgb) => {
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

const averageBlock = (
  imageData: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
) => {
  let totalR = 0
  let totalG = 0
  let totalB = 0
  let count = 0

  const safeEndX = clamp(endX, startX + 1, imageWidth)
  const safeEndY = clamp(endY, startY + 1, imageHeight)

  for (let y = startY; y < safeEndY; y += 1) {
    for (let x = startX; x < safeEndX; x += 1) {
      const index = (y * imageWidth + x) * 4
      totalR += imageData[index]
      totalG += imageData[index + 1]
      totalB += imageData[index + 2]
      count += 1
    }
  }

  return {
    r: Math.round(totalR / count),
    g: Math.round(totalG / count),
    b: Math.round(totalB / count),
  }
}

const findNearestPaletteColor = (target: Rgb, palette: PaletteColor[]) => {
  let winner = palette[0]
  let minDistance = Number.POSITIVE_INFINITY

  for (const color of palette) {
    const distance = colorDistance(target, hexToRgb(color.hex))
    if (distance < minDistance) {
      minDistance = distance
      winner = color
    }
  }

  return winner
}

const mergeColors = (colors: Rgb[], sensitivity: number) => {
  const merged: Rgb[] = []
  const threshold = 8 + sensitivity * 1.4

  for (const color of colors) {
    const existing = merged.find((item) => colorDistance(item, color) <= threshold)
    if (existing) {
      existing.r = Math.round((existing.r + color.r) / 2)
      existing.g = Math.round((existing.g + color.g) / 2)
      existing.b = Math.round((existing.b + color.b) / 2)
    } else {
      merged.push({ ...color })
    }
  }

  return merged
}

const pickPaletteSubset = (colors: Rgb[], colorLimit: number) => {
  const ranked = [...beadPalette]
    .map((paletteColor) => {
      const rgb = hexToRgb(paletteColor.hex)
      const score = colors.reduce((sum, item) => sum + colorDistance(item, rgb), 0)
      return { paletteColor, score }
    })
    .sort((left, right) => left.score - right.score)

  return ranked.slice(0, colorLimit).map((item) => item.paletteColor)
}

const drawPatternCanvas = (
  result: PatternResult,
  options: { cellSize: number; showCodes: boolean; includeLegend: boolean },
) => {
  const { cellSize, showCodes, includeLegend } = options
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
    context.fillStyle = cell.color.hex
    context.fillRect(cell.x * cellSize, cell.y * cellSize, cellSize, cellSize)
    context.strokeStyle = 'rgba(31, 41, 55, 0.16)'
    context.strokeRect(cell.x * cellSize, cell.y * cellSize, cellSize, cellSize)

    if (showCodes && cellSize >= 18) {
      context.fillStyle = '#111827'
      context.font = `${Math.floor(cellSize * 0.33)}px ui-monospace, SFMono-Regular, monospace`
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(cell.color.id.slice(0, 2).toUpperCase(), cell.x * cellSize + cellSize / 2, cell.y * cellSize + cellSize / 2)
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
      context.fillText(`${item.color.name}  x ${item.count}`, legendX + 28, top + 1)
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

function App() {
  const [sourceMode, setSourceMode] = useState<SourceMode>('photo')
  const [gridSize, setGridSize] = useState(48)
  const [colorLimit, setColorLimit] = useState(18)
  const [mergeSensitivity, setMergeSensitivity] = useState(26)
  const [sourceImage, setSourceImage] = useState<string | null>(null)
  const [sourceFileName, setSourceFileName] = useState('未上传图片')
  const [pattern, setPattern] = useState<PatternResult | null>(null)
  const [activeColorIds, setActiveColorIds] = useState<string[]>(beadPalette.slice(0, 24).map((item) => item.id))
  const [zoom, setZoom] = useState(1)
  const [isGenerating, setIsGenerating] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const enabledPalette = useMemo(() => {
    const selected = beadPalette.filter((item) => activeColorIds.includes(item.id))
    return selected.length > 1 ? selected : beadPalette
  }, [activeColorIds])

  useEffect(() => {
    if (!pattern || !previewCanvasRef.current) {
      return
    }

    const canvas = drawPatternCanvas(pattern, {
      cellSize: Math.max(12, Math.floor(26 * zoom)),
      showCodes: true,
      includeLegend: false,
    })

    const target = previewCanvasRef.current
    target.width = canvas.width
    target.height = canvas.height

    const context = target.getContext('2d')
    if (!context) {
      return
    }

    context.clearRect(0, 0, target.width, target.height)
    context.drawImage(canvas, 0, 0)
  }, [pattern, zoom])

  useEffect(() => {
    return () => {
      if (sourceImage) {
        URL.revokeObjectURL(sourceImage)
      }
    }
  }, [sourceImage])

  const handleUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    if (sourceImage) {
      URL.revokeObjectURL(sourceImage)
    }

    setErrorMessage('')
    setSourceFileName(file.name)
    setPattern(null)
    setSourceImage(URL.createObjectURL(file))
  }

  const toggleColor = (id: string) => {
    setActiveColorIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
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

      const workingCanvas = document.createElement('canvas')
      workingCanvas.width = image.width
      workingCanvas.height = image.height
      const workingContext = workingCanvas.getContext('2d', { willReadFrequently: true })

      if (!workingContext) {
        throw new Error('无法读取图片像素')
      }

      workingContext.drawImage(image, 0, 0)
      const raw = workingContext.getImageData(0, 0, image.width, image.height).data
      const blockColors: Rgb[] = []

      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const startX = Math.floor((col / cols) * image.width)
          const startY = Math.floor((row / rows) * image.height)
          const endX = Math.floor(((col + 1) / cols) * image.width)
          const endY = Math.floor(((row + 1) / rows) * image.height)

          blockColors.push(
            averageBlock(raw, image.width, image.height, startX, startY, endX, endY),
          )
        }
      }

      const mergedColors = sourceMode === 'pattern' ? blockColors : mergeColors(blockColors, mergeSensitivity)
      const subset = pickPaletteSubset(mergedColors, Math.min(colorLimit, enabledPalette.length))
      const workingPalette =
        sourceMode === 'pattern'
          ? enabledPalette
          : enabledPalette.filter((item) => subset.some((subsetColor) => subsetColor.id === item.id))

      const paletteToUse = workingPalette.length > 0 ? workingPalette : enabledPalette
      const counts = new Map<string, number>()

      const cells = blockColors.map((color, index) => {
        const mappedColor = findNearestPaletteColor(color, paletteToUse)
        counts.set(mappedColor.id, (counts.get(mappedColor.id) ?? 0) + 1)
        return {
          x: index % cols,
          y: Math.floor(index / cols),
          color: mappedColor,
        }
      })

      const previewCanvas = drawPatternCanvas(
        {
          rows,
          cols,
          cells,
          legend: [],
          previewDataUrl: '',
        },
        { cellSize: 18, showCodes: false, includeLegend: false },
      )

      const legend = [...counts.entries()]
        .map(([id, count]) => ({
          color: beadPalette.find((item) => item.id === id)!,
          count,
        }))
        .sort((left, right) => right.count - left.count)

      startTransition(() => {
        setPattern({
          rows,
          cols,
          cells,
          legend,
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

  return (
    <div className="app-shell">
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">拼豆图案生成器</span>
          <h1>上传图片，生成拼豆图案</h1>
          <p>
            参考目标站点重建的在线拼豆工具。支持普通图片转拼豆图纸、已有图纸保留原色修改、颜色选择、预览、放大与导出。
          </p>
          <div className="hero-actions">
            <button className="primary-button" onClick={handleGenerate} disabled={isGenerating || !sourceImage}>
              {isGenerating ? '生成中...' : '生成拼豆图案'}
            </button>
            <button className="secondary-button" onClick={() => setIsPreviewOpen(true)} disabled={!pattern}>
              预览
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
              <span>使用颜色</span>
            </div>
            <div>
              <strong>{totalBeads}</strong>
              <span>拼豆颗数</span>
            </div>
          </div>
        </div>

        <div className="hero-card">
          <div className="card-header">
            <span>生成拼豆模式</span>
            <div className="mode-switch">
              <button
                className={sourceMode === 'photo' ? 'chip active' : 'chip'}
                onClick={() => setSourceMode('photo')}
              >
                上传普通图片，生成拼豆图案
              </button>
              <button
                className={sourceMode === 'pattern' ? 'chip active' : 'chip'}
                onClick={() => setSourceMode('pattern')}
              >
                上传已有拼豆图纸，保留原色，直接修改
              </button>
            </div>
          </div>

          <label className="upload-panel">
            <input type="file" accept="image/*" onChange={handleUpload} />
            <span>上传图片</span>
            <small>{sourceFileName}</small>
          </label>

          <div className="control-grid">
            <label>
              <span>网格大小: {gridSize}</span>
              <input
                type="range"
                min="16"
                max="96"
                value={gridSize}
                onChange={(event) => setGridSize(Number(event.target.value))}
              />
            </label>
            <label>
              <span>颜色数量: {colorLimit}</span>
              <input
                type="range"
                min="6"
                max="36"
                value={colorLimit}
                onChange={(event) => setColorLimit(Number(event.target.value))}
              />
            </label>
            <label>
              <span>颜色合并敏感度: {mergeSensitivity}</span>
              <input
                type="range"
                min="0"
                max="60"
                value={mergeSensitivity}
                onChange={(event) => setMergeSensitivity(Number(event.target.value))}
              />
            </label>
          </div>

          {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
        </div>
      </section>

      <section className="workspace">
        <div className="panel">
          <div className="panel-top">
            <h2>颜色选择</h2>
            <span>自定义</span>
          </div>
          <div className="palette-grid">
            {beadPalette.map((color) => {
              const active = activeColorIds.includes(color.id)
              return (
                <button
                  key={color.id}
                  className={active ? 'palette-swatch active' : 'palette-swatch'}
                  onClick={() => toggleColor(color.id)}
                  title={color.name}
                >
                  <span style={{ backgroundColor: color.hex }} />
                  <small>{color.name}</small>
                </button>
              )
            })}
          </div>
        </div>

        <div className="panel preview-panel">
          <div className="panel-top">
            <h2>预览图</h2>
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

          <div className="preview-grid">
            <div className="image-card">
              <h3>原图</h3>
              {sourceImage ? <img src={sourceImage} alt="原图" /> : <div className="empty-state">等待上传图片</div>}
            </div>
            <div className="image-card">
              <h3>生成拼豆</h3>
              {pattern ? <img src={pattern.previewDataUrl} alt="拼豆预览图" /> : <div className="empty-state">点击“生成拼豆图案”</div>}
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-top">
            <h2>颜色图例</h2>
            <button className="primary-button" onClick={downloadPattern} disabled={!pattern}>
              导出图案
            </button>
          </div>
          <div className="legend-list">
            {pattern?.legend.length ? (
              pattern.legend.map((item) => (
                <div className="legend-item" key={item.color.id}>
                  <span className="legend-color" style={{ backgroundColor: item.color.hex }} />
                  <div>
                    <strong>{item.color.name}</strong>
                    <small>{item.color.hex}</small>
                  </div>
                  <em>x {item.count}</em>
                </div>
              ))
            ) : (
              <div className="empty-state compact">生成后显示颜色统计和用量。</div>
            )}
          </div>
        </div>
      </section>

      <section className="community">
        <div className="community-copy">
          <span className="eyebrow">拼豆图共享社区</span>
          <h2>上传您的图纸</h2>
          <p>下载的图纸仅供个人使用，请勿用于商业用途，转载请注明出处。</p>
        </div>
        <div className="community-cards">
          {[
            ['动漫头像', '48 x 52', '18 色'],
            ['像素宠物', '32 x 32', '12 色'],
            ['风景小图', '64 x 46', '24 色'],
          ].map(([title, size, colors]) => (
            <article className="sample-card" key={title}>
              <div className="sample-placeholder" />
              <strong>{title}</strong>
              <span>{size}</span>
              <small>{colors}</small>
            </article>
          ))}
        </div>
      </section>

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
