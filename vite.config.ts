import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { type Connect, defineConfig, type Plugin } from 'vite'

// Project site: https://dieuwedeboer.github.io/nz-demographic-map/
// Local/dev and custom domains use `/`.
const base = process.env.GITHUB_PAGES === 'true' ? '/nz-demographic-map/' : '/'
const localPmtilesRoute = '/__local_pmtiles__/'
const localPmtilesDir = path.resolve(
  process.env.GENERATED_PMTILES_CACHE_DIR || '.cache/generated-pmtiles',
)

function parseRange(range: string | undefined, size: number) {
  if (!range) return null
  const match = range.match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return null

  const [, startText, endText] = match
  if (!startText && !endText) return null

  if (!startText) {
    const suffixLength = Number(endText)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    }
  }

  const start = Number(startText)
  const end = endText ? Number(endText) : size - 1
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return null
  }

  return {
    start,
    end: Math.min(end, size - 1),
  }
}

function localPmtilesMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    const requestUrl = req.url ? new URL(req.url, 'http://localhost') : null
    const pathname = requestUrl?.pathname ?? ''
    if (!pathname.startsWith(localPmtilesRoute)) {
      next()
      return
    }

    const requestedPath = decodeURIComponent(pathname.slice(localPmtilesRoute.length))
      .replace(/^\/+/, '')
      .replace(/^tiles\//, '')
    const filePath = path.resolve(localPmtilesDir, requestedPath)
    if (!filePath.startsWith(`${localPmtilesDir}${path.sep}`) || !filePath.endsWith('.pmtiles')) {
      res.statusCode = 404
      res.end('Not found')
      return
    }

    try {
      const stats = await fs.stat(filePath)
      const range = parseRange(req.headers.range, stats.size)

      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Content-Type', 'application/octet-stream')

      if (range) {
        res.statusCode = 206
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stats.size}`)
        res.setHeader('Content-Length', String(range.end - range.start + 1))
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        createReadStream(filePath, range).pipe(res)
        return
      }

      res.statusCode = 200
      res.setHeader('Content-Length', String(stats.size))
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(filePath).pipe(res)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.statusCode = 404
        res.end(`Missing local PMTiles file: ${requestedPath}`)
        return
      }
      next(error)
    }
  }
}

function localPmtilesPlugin(): Plugin {
  return {
    name: 'local-pmtiles',
    configureServer(server) {
      server.middlewares.use(localPmtilesMiddleware())
    },
    configurePreviewServer(server) {
      server.middlewares.use(localPmtilesMiddleware())
    },
  }
}

export default defineConfig({
  base,
  plugins: [react(), ...(process.env.VITE_LOCAL_PMTILES === 'true' ? [localPmtilesPlugin()] : [])],
  build: {
    target: 'es2020',
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ['maplibre-gl', 'pmtiles'],
          react: ['react', 'react-dom'],
        },
      },
    },
    chunkSizeWarningLimit: 1200,
  },
})
