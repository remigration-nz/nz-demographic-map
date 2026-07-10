import fs from 'fs/promises'
import { VectorTile } from '@mapbox/vector-tile'
import { PMTiles } from 'pmtiles'
import Pbf from 'pbf'

const TIERS = ['rc', 'ta', 'sa2']
const FILL_TIERS = new Set(TIERS)
const BORDER_ZOOMS = {
  rc: 8,
  ta: 10,
  sa2: 12,
}
const DATAFINDER_LAYERS = {
  rc: {
    id: 120945,
    page: 'https://datafinder.stats.govt.nz/layer/120945-regional-council-2025-clipped/',
    sourceNameProp: 'REGC2025_V1_00_NAME_ASCII',
    sourceOutputNameProp: 'REGC2025_V1_00_NAME',
    candidateNameProp: 'REGC2025_2',
    outputNameProp: 'REGC2025_1',
  },
  ta: {
    id: 120962,
    page: 'https://datafinder.stats.govt.nz/layer/120962-territorial-authority-2025-clipped/',
    sourceNameProp: 'TA2025_V1_00_NAME_ASCII',
    sourceOutputNameProp: 'TA2025_V1_00_NAME',
    candidateNameProp: 'TA2025_V_2',
    outputNameProp: 'TA2025_V_1',
  },
  sa2: {
    id: 120969,
    page: 'https://datafinder.stats.govt.nz/layer/120969-statistical-area-2-2025-clipped/',
    sourceNameProp: 'SA22025_V1_00_NAME_ASCII',
    sourceOutputNameProp: 'SA22025_V1_00_NAME_ASCII',
    candidateNameProp: 'SA22025__2',
    outputNameProp: 'SA22025__2',
  },
}
const NATIONAL_NAME = 'Total - New Zealand by regional council'
const QUERY_CONCURRENCY = 8
const QUERY_RADIUS_METRES = 10000
const MAX_CANDIDATES_PER_AREA = 12
const SOURCE_CACHE_DIR = process.env.DATAFINDER_CACHE_DIR || '.cache/datafinder-boundaries'
const GENERATED_TILE_CACHE_DIR = process.env.GENERATED_TILE_CACHE_DIR || '.cache/generated-tiles'
const SIMPLIFY_TOLERANCE = {
  rc: 0.002,
  ta: 0.001,
  sa2: 0.00015,
}

function fileSource(file) {
  return {
    getKey: () => file,
    getBytes: async (offset, length) => {
      const handle = await fs.open(file, 'r')
      try {
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, offset)
        return {
          data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        }
      } finally {
        await handle.close()
      }
    },
  }
}

function lonToTileX(lon, zoom) {
  return Math.floor(((lon + 180) / 360) * 2 ** zoom)
}

function latToTileY(lat, zoom) {
  const radians = (lat * Math.PI) / 180
  return Math.floor(
    ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * 2 ** zoom,
  )
}

function tilePointToLonLat(point, tileX, tileY, zoom, extent) {
  const tilesAtZoom = 2 ** zoom
  const lon = ((tileX + point.x / extent) / tilesAtZoom) * 360 - 180
  const mercatorY = Math.PI * (1 - (2 * (tileY + point.y / extent)) / tilesAtZoom)
  const lat = (Math.atan(Math.sinh(mercatorY)) * 180) / Math.PI
  return [roundCoordinate(lon), roundCoordinate(lat)]
}

function roundCoordinate(value) {
  return Number(value.toFixed(7))
}

function pointKey(point) {
  return `${point[0]},${point[1]}`
}

function segmentKey(a, b) {
  const start = pointKey(a)
  const end = pointKey(b)
  return start < end ? `${start}|${end}` : `${end}|${start}`
}

function addCandidate(candidatesByName, name, point) {
  if (!name) return
  const candidates = candidatesByName.get(name) || []
  const key = pointKey(point)
  if (candidates.some(candidate => pointKey(candidate) === key)) return
  if (candidates.length >= MAX_CANDIDATES_PER_AREA) return

  candidates.push(point)
  candidatesByName.set(name, candidates)
}

function ringCentroid(points) {
  if (points.length === 0) return null
  const total = points.reduce(
    (sum, point) => [sum[0] + point[0], sum[1] + point[1]],
    [0, 0],
  )
  return [roundCoordinate(total[0] / points.length), roundCoordinate(total[1] / points.length)]
}

async function collectCandidatePoints(tier) {
  const sourcePath = `public/tiles/${tier}.pmtiles`
  const archive = new PMTiles(fileSource(sourcePath))
  const header = await archive.getHeader()
  const zoom = Math.max(header.minZoom, Math.min(header.maxZoom, BORDER_ZOOMS[tier]))
  const maxTile = 2 ** zoom - 1
  const minX = Math.max(0, lonToTileX(header.minLon, zoom) - 1)
  const maxX = Math.min(maxTile, lonToTileX(header.maxLon, zoom) + 1)
  const minY = Math.max(0, latToTileY(header.maxLat, zoom) - 1)
  const maxY = Math.min(maxTile, latToTileY(header.minLat, zoom) + 1)
  const candidatesByName = new Map()
  const candidateNameProp = DATAFINDER_LAYERS[tier].candidateNameProp

  for (let tileX = minX; tileX <= maxX; tileX++) {
    for (let tileY = minY; tileY <= maxY; tileY++) {
      const tile = await archive.getZxy(zoom, tileX, tileY)
      if (!tile) continue

      const vectorTile = new VectorTile(new Pbf(new Uint8Array(tile.data)))
      const layer = vectorTile.layers[tier]
      if (!layer) continue

      for (let index = 0; index < layer.length; index++) {
        const feature = layer.feature(index)
        const geometry = feature.loadGeometry()
        const name = feature.properties[candidateNameProp] || ''

        for (const ring of geometry) {
          const points = ring.map(point => tilePointToLonLat(point, tileX, tileY, zoom, feature.extent))
          const centroid = ringCentroid(points)
          if (centroid) addCandidate(candidatesByName, name, centroid)
          if (points[0]) addCandidate(candidatesByName, name, points[0])
          if (points.length > 2) {
            addCandidate(candidatesByName, name, points[Math.floor(points.length / 2)])
          }
        }
      }
    }
  }

  return candidatesByName
}

async function getDatafinderToken(tier) {
  const tokenFromEnv = process.env.DATAFINDER_API_KEY
  if (tokenFromEnv) return tokenFromEnv

  const response = await fetch(DATAFINDER_LAYERS[tier].page)
  if (!response.ok) {
    throw new Error(`Unable to fetch Datafinder layer page for ${tier}: ${response.status}`)
  }
  const html = await response.text()
  const match = html.match(/<script id="pre-cached-token" type="application\/json">([^<]+)<\/script>/)
  if (!match) {
    throw new Error(`Unable to find Datafinder token on ${DATAFINDER_LAYERS[tier].page}`)
  }
  const token = JSON.parse(match[1])
  return token.key
}

async function fetchSourceFeature(tier, token, name, candidates) {
  const layer = DATAFINDER_LAYERS[tier]
  for (const [lon, lat] of candidates) {
    const params = new URLSearchParams({
      key: token,
      layer: String(layer.id),
      x: String(lon),
      y: String(lat),
      max_results: '25',
      radius: String(QUERY_RADIUS_METRES),
      geometry: 'true',
      with_field_names: 'true',
    })
    const url = `https://datafinder.stats.govt.nz/services/query/v1/vector.json?${params}`
    const response = await fetch(url)
    if (!response.ok) continue

    const result = await response.json()
    const features = result.vectorQuery?.layers?.[layer.id]?.features || []
    const match = features.find(feature => feature.properties?.[layer.sourceNameProp] === name)
    if (match?.geometry) return match
  }

  return null
}

function sourceFeatureCachePath(tier, name) {
  return `${SOURCE_CACHE_DIR}/${tier}/${encodeURIComponent(name)}.json`
}

async function readCachedSourceFeature(tier, name) {
  const cachePath = sourceFeatureCachePath(tier, name)
  try {
    const cached = JSON.parse(await fs.readFile(cachePath, 'utf8'))
    const layer = DATAFINDER_LAYERS[tier]
    if (
      cached.layerId === layer.id &&
      cached.sourceNameProp === layer.sourceNameProp &&
      cached.feature?.properties?.[layer.sourceNameProp] === name &&
      cached.feature?.geometry
    ) {
      return cached.feature
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`Ignoring invalid source feature cache: ${cachePath}`)
    }
  }

  return null
}

async function writeCachedSourceFeature(tier, name, feature) {
  const cachePath = sourceFeatureCachePath(tier, name)
  const layer = DATAFINDER_LAYERS[tier]
  const cached = {
    layerId: layer.id,
    sourceNameProp: layer.sourceNameProp,
    feature,
  }

  await fs.mkdir(`${SOURCE_CACHE_DIR}/${tier}`, { recursive: true })
  await fs.writeFile(cachePath, `${JSON.stringify(cached)}\n`)
}

async function mapLimit(items, limit, iteratee) {
  const results = new Array(items.length)
  let cursor = 0

  async function worker() {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await iteratee(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

async function fetchSourceFeatures(tier, candidatesByName) {
  const entries = [...candidatesByName.entries()]
  let completed = 0
  let cacheHits = 0
  let networkFetches = 0
  let tokenPromise

  const features = await mapLimit(entries, QUERY_CONCURRENCY, async ([name, candidates]) => {
    let feature = await readCachedSourceFeature(tier, name)
    if (feature) {
      cacheHits += 1
    } else {
      tokenPromise ||= getDatafinderToken(tier)
      const token = await tokenPromise
      feature = await fetchSourceFeature(tier, token, name, candidates)
      if (feature) {
        networkFetches += 1
        await writeCachedSourceFeature(tier, name, feature)
      }
    }

    completed += 1
    if (completed % 100 === 0 || completed === entries.length) {
      console.log(
        `${tier}: loaded ${completed.toLocaleString()} / ${entries.length.toLocaleString()} ` +
          `(cache ${cacheHits.toLocaleString()}, fetched ${networkFetches.toLocaleString()})`,
      )
    }
    if (!feature) {
      throw new Error(`Unable to fetch source geometry for ${tier} area: ${name}`)
    }
    return feature
  })

  return features
}

function normalizePoint(point) {
  return [roundCoordinate(point[0]), roundCoordinate(point[1])]
}

function simplifyRing(ring, tolerance, segmentStats, sharedChainCache) {
  if (ring.length <= 3) return ring

  const closed = pointKey(ring[0]) === pointKey(ring[ring.length - 1])
  const points = closed ? ring.slice(0, -1) : ring
  if (points.length <= 2) return ring
  const chains = splitRingIntoTopologyChains(points, closed, segmentStats)
  const simplifiedChains = chains.map(chain =>
    simplifyTopologyChain(chain.points, chain.shared, tolerance, sharedChainCache),
  )
  const simplified = joinTopologyChains(simplifiedChains, closed)

  if (closed && simplified.length < 4) return ring
  return simplified
}

function simplifyLine(points, tolerance) {
  if (points.length <= 2) return points

  const keep = new Array(points.length).fill(false)
  keep[0] = true
  keep[points.length - 1] = true
  simplifySection(points, 0, points.length - 1, tolerance * tolerance, keep)
  return points.filter((_, index) => keep[index])
}

function simplifySection(points, start, end, toleranceSquared, keep) {
  let maxDistance = 0
  let maxIndex = start

  for (let index = start + 1; index < end; index++) {
    const distance = perpendicularDistanceSquared(points[index], points[start], points[end])
    if (distance > maxDistance) {
      maxDistance = distance
      maxIndex = index
    }
  }

  if (maxDistance <= toleranceSquared) return

  keep[maxIndex] = true
  simplifySection(points, start, maxIndex, toleranceSquared, keep)
  simplifySection(points, maxIndex, end, toleranceSquared, keep)
}

function perpendicularDistanceSquared(point, start, end) {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]

  if (dx === 0 && dy === 0) {
    return squaredDistance(point, start)
  }

  const t = Math.max(
    0,
    Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)),
  )
  const projection = [start[0] + t * dx, start[1] + t * dy]
  return squaredDistance(point, projection)
}

function squaredDistance(a, b) {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  return dx * dx + dy * dy
}

function splitRingIntoTopologyChains(points, closed, segmentStats) {
  const segmentCount = closed ? points.length : points.length - 1
  const statuses = Array.from({ length: segmentCount }, (_, index) =>
    isSharedSegment(points[index], points[(index + 1) % points.length], segmentStats),
  )
  const startIndex = closed ? topologyStartIndex(points, statuses, segmentStats) : 0
  const chains = []
  let currentPoints = [points[startIndex]]
  let currentShared = statuses[startIndex]

  for (let offset = 0; offset < segmentCount; offset++) {
    const segmentIndex = closed ? (startIndex + offset) % segmentCount : offset
    const nextIndex = (segmentIndex + 1) % points.length
    const endPoint = points[nextIndex]
    currentPoints.push(endPoint)

    const nextOffset = offset + 1
    if (nextOffset === segmentCount) {
      chains.push({ points: currentPoints, shared: currentShared })
      break
    }

    const nextSegmentIndex = closed ? (startIndex + nextOffset) % segmentCount : nextOffset
    const nextShared = statuses[nextSegmentIndex]
    if (shouldBreakTopologyChain(endPoint, currentShared, nextShared, segmentStats)) {
      chains.push({ points: currentPoints, shared: currentShared })
      currentPoints = [endPoint]
      currentShared = nextShared
    }
  }

  return chains
}

function topologyStartIndex(points, statuses, segmentStats) {
  for (let index = 0; index < statuses.length; index++) {
    const previousIndex = (index - 1 + statuses.length) % statuses.length
    if (shouldBreakTopologyChain(points[index], statuses[previousIndex], statuses[index], segmentStats)) {
      return index
    }
  }

  return 0
}

function shouldBreakTopologyChain(point, currentShared, nextShared, segmentStats) {
  return currentShared !== nextShared || (currentShared && sharedVertexDegree(point, segmentStats) !== 2)
}

function isSharedSegment(start, end, segmentStats) {
  return (segmentStats.segmentCounts.get(segmentKey(start, end)) || 0) > 1
}

function sharedVertexDegree(point, segmentStats) {
  return segmentStats.sharedVertexDegrees.get(pointKey(point)) || 0
}

function simplifyTopologyChain(points, shared, tolerance, sharedChainCache) {
  if (!shared) return simplifyLine(points, tolerance)

  const directionKey = chainKey(points)
  const reversedPoints = [...points].reverse()
  const reverseKey = chainKey(reversedPoints)
  const reversed = reverseKey < directionKey
  const canonicalKey = reversed ? reverseKey : directionKey
  const cached = sharedChainCache.get(canonicalKey)
  if (cached) return reversed ? [...cached].reverse() : cached

  const simplified = simplifyLine(reversed ? reversedPoints : points, tolerance)
  sharedChainCache.set(canonicalKey, simplified)
  return reversed ? [...simplified].reverse() : simplified
}

function chainKey(points) {
  const keys = []
  for (let index = 1; index < points.length; index++) {
    keys.push(segmentKey(points[index - 1], points[index]))
  }
  return keys.join('>')
}

function joinTopologyChains(chains, closed) {
  const coordinates = []
  for (const chain of chains) {
    if (chain.length === 0) continue
    if (coordinates.length === 0) {
      coordinates.push(...chain)
      continue
    }

    const last = coordinates[coordinates.length - 1]
    const first = chain[0]
    coordinates.push(...(pointKey(last) === pointKey(first) ? chain.slice(1) : chain))
  }

  if (closed && coordinates.length > 0) {
    const first = coordinates[0]
    const last = coordinates[coordinates.length - 1]
    if (pointKey(first) !== pointKey(last)) coordinates.push(first)
  }

  return coordinates
}

function buildSegmentStats(features) {
  const segmentCounts = new Map()
  for (const feature of features) {
    forEachRing(feature.geometry, ring => {
      const normalized = ring.map(normalizePoint)
      for (let index = 1; index < normalized.length; index++) {
        const start = normalized[index - 1]
        const end = normalized[index]
        if (pointKey(start) === pointKey(end)) continue

        const key = segmentKey(start, end)
        segmentCounts.set(key, (segmentCounts.get(key) || 0) + 1)
      }
    })
  }

  const sharedVertexDegrees = new Map()
  for (const [key, count] of segmentCounts) {
    if (count <= 1) continue
    for (const point of key.split('|')) {
      sharedVertexDegrees.set(point, (sharedVertexDegrees.get(point) || 0) + 1)
    }
  }

  return { segmentCounts, sharedVertexDegrees }
}

function forEachRing(geometry, callback) {
  if (geometry.type === 'Polygon') {
    for (const ring of geometry.coordinates) callback(ring)
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates) {
      for (const ring of polygon) callback(ring)
    }
  }
}

function simplifyGeometry(tier, geometry, segmentStats, sharedChainCache) {
  const tolerance = SIMPLIFY_TOLERANCE[tier]
  if (geometry.type === 'Polygon') {
    return {
      type: 'Polygon',
      coordinates: geometry.coordinates.map(ring =>
        simplifyRing(ring.map(normalizePoint), tolerance, segmentStats, sharedChainCache),
      ),
    }
  }
  if (geometry.type === 'MultiPolygon') {
    return {
      type: 'MultiPolygon',
      coordinates: geometry.coordinates.map(polygon =>
        polygon.map(ring =>
          simplifyRing(ring.map(normalizePoint), tolerance, segmentStats, sharedChainCache),
        ),
      ),
    }
  }
  throw new Error(`Unsupported geometry type: ${geometry.type}`)
}

function fillFeature(tier, feature, segmentStats, sharedChainCache) {
  const layer = DATAFINDER_LAYERS[tier]
  const name = feature.properties?.[layer.sourceOutputNameProp]
  return {
    type: 'Feature',
    properties: {
      [layer.outputNameProp]: name,
    },
    geometry: simplifyGeometry(tier, feature.geometry, segmentStats, sharedChainCache),
  }
}

function nationalFillFeature(features) {
  const polygons = []
  for (const feature of features) {
    if (feature.geometry.type === 'Polygon') {
      polygons.push(feature.geometry.coordinates)
    } else if (feature.geometry.type === 'MultiPolygon') {
      polygons.push(...feature.geometry.coordinates)
    }
  }

  return {
    type: 'Feature',
    properties: {
      name: NATIONAL_NAME,
    },
    geometry: {
      type: 'MultiPolygon',
      coordinates: polygons,
    },
  }
}

async function writeNationalGeometry(features) {
  const fillOutputPath = `${GENERATED_TILE_CACHE_DIR}/national-fills.geojson`

  await fs.writeFile(
    fillOutputPath,
    `${JSON.stringify({
      type: 'FeatureCollection',
      features: [nationalFillFeature(features)],
    })}\n`,
  )
  console.log(`${fillOutputPath}: 1 national polygon`)
}

async function generateBorders(tier) {
  await fs.mkdir(GENERATED_TILE_CACHE_DIR, { recursive: true })
  const candidatesByName = await collectCandidatePoints(tier)
  console.log(`${tier}: found ${candidatesByName.size.toLocaleString()} areas in PMTiles`)

  const sourceFeatures = await fetchSourceFeatures(tier, candidatesByName)
  const segmentStats = buildSegmentStats(sourceFeatures)
  const sharedChainCache = new Map()
  const fillFeatures = sourceFeatures.map(feature =>
    fillFeature(tier, feature, segmentStats, sharedChainCache),
  )

  if (FILL_TIERS.has(tier)) {
    const fillOutputPath = `${GENERATED_TILE_CACHE_DIR}/${tier}-fills.geojson`
    const fillCollection = {
      type: 'FeatureCollection',
      features: fillFeatures,
    }

    await fs.writeFile(fillOutputPath, `${JSON.stringify(fillCollection)}\n`)
    console.log(`${fillOutputPath}: ${fillCollection.features.length.toLocaleString()} polygons`)
  }

  if (tier === 'rc') {
    await writeNationalGeometry(fillFeatures)
  }
}

for (const tier of TIERS) {
  await generateBorders(tier)
}
