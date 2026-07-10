import fs from 'fs/promises'
import { gzipSync } from 'zlib'
import { GeoJSONVT } from '@maplibre/geojson-vt'
import { fromGeojsonVt } from '@maplibre/vt-pbf'
import { zxyToTileId } from 'pmtiles'

const HEADER_SIZE_BYTES = 127
const COMPRESSION = {
  NONE: 1,
  GZIP: 2,
}
const TILE_TYPE = {
  MVT: 1,
}
const GENERATED_TILE_CACHE_DIR = process.env.GENERATED_TILE_CACHE_DIR || '.cache/generated-tiles'
const TILESETS = {
  national: {
    input: `${GENERATED_TILE_CACHE_DIR}/national-fills.geojson`,
    output: 'public/tiles/national.pmtiles',
    layer: 'national',
    nameProp: 'name',
    minZoom: 0,
    maxZoom: 8,
  },
  rc: {
    input: `${GENERATED_TILE_CACHE_DIR}/rc-fills.geojson`,
    output: 'public/tiles/rc.pmtiles',
    layer: 'rc',
    nameProp: 'REGC2025_1',
    minZoom: 0,
    maxZoom: 8,
  },
  ta: {
    input: `${GENERATED_TILE_CACHE_DIR}/ta-fills.geojson`,
    output: 'public/tiles/ta.pmtiles',
    layer: 'ta',
    nameProp: 'TA2025_V_1',
    minZoom: 0,
    maxZoom: 11,
  },
  sa2: {
    input: `${GENERATED_TILE_CACHE_DIR}/sa2-fills.geojson`,
    output: 'public/tiles/sa2.pmtiles',
    layer: 'sa2',
    nameProp: 'SA22025__2',
    minZoom: 0,
    maxZoom: 14,
  },
}
const TILE_OPTIONS = {
  extent: 4096,
  buffer: 512,
  tolerance: 0,
  indexMaxPoints: 0,
  debug: 0,
}
const MVT_OPTIONS = {
  extent: TILE_OPTIONS.extent,
  version: 2,
}
const MAX_LEAF_ENTRIES = 4096

function writeVarint(value, bytes) {
  let remaining = value
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80)
    remaining = Math.floor(remaining / 0x80)
  }
  bytes.push(remaining)
}

function serializeDirectory(entries) {
  const bytes = []
  writeVarint(entries.length, bytes)

  let lastTileId = 0
  for (const entry of entries) {
    writeVarint(entry.tileId - lastTileId, bytes)
    lastTileId = entry.tileId
  }
  for (const entry of entries) writeVarint(entry.runLength, bytes)
  for (const entry of entries) writeVarint(entry.length, bytes)
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    const previous = entries[index - 1]
    const isContiguous = previous && entry.offset === previous.offset + previous.length
    writeVarint(isContiguous ? 0 : entry.offset + 1, bytes)
  }

  return Uint8Array.from(bytes)
}

function writeUint64(view, offset, value) {
  const low = value >>> 0
  const high = Math.floor(value / 2 ** 32) >>> 0
  view.setUint32(offset, low, true)
  view.setUint32(offset + 4, high, true)
}

function writeScaledCoordinate(view, offset, value) {
  view.setInt32(offset, Math.round(value * 10_000_000), true)
}

function boundsForFeatureCollection(collection) {
  const bounds = {
    minLon: Number.POSITIVE_INFINITY,
    minLat: Number.POSITIVE_INFINITY,
    maxLon: Number.NEGATIVE_INFINITY,
    maxLat: Number.NEGATIVE_INFINITY,
  }

  function visitCoordinate(coordinate) {
    const [lon, lat] = coordinate
    bounds.minLon = Math.min(bounds.minLon, lon)
    bounds.minLat = Math.min(bounds.minLat, lat)
    bounds.maxLon = Math.max(bounds.maxLon, lon)
    bounds.maxLat = Math.max(bounds.maxLat, lat)
  }

  function visitCoordinates(coordinates) {
    if (typeof coordinates[0] === 'number') {
      visitCoordinate(coordinates)
      return
    }
    for (const child of coordinates) visitCoordinates(child)
  }

  for (const feature of collection.features) {
    visitCoordinates(feature.geometry.coordinates)
  }

  return bounds
}

function writeHeader({
  rootDirectoryOffset,
  rootDirectoryLength,
  jsonMetadataOffset,
  jsonMetadataLength,
  leafDirectoryOffset,
  leafDirectoryLength,
  tileDataOffset,
  tileDataLength,
  numAddressedTiles,
  numTileEntries,
  bounds,
  minZoom,
  maxZoom,
}) {
  const header = new Uint8Array(HEADER_SIZE_BYTES)
  header.set(new TextEncoder().encode('PMTiles'), 0)
  const view = new DataView(header.buffer)
  view.setUint8(7, 3)
  writeUint64(view, 8, rootDirectoryOffset)
  writeUint64(view, 16, rootDirectoryLength)
  writeUint64(view, 24, jsonMetadataOffset)
  writeUint64(view, 32, jsonMetadataLength)
  writeUint64(view, 40, leafDirectoryOffset)
  writeUint64(view, 48, leafDirectoryLength)
  writeUint64(view, 56, tileDataOffset)
  writeUint64(view, 64, tileDataLength)
  writeUint64(view, 72, numAddressedTiles)
  writeUint64(view, 80, numTileEntries)
  writeUint64(view, 88, numTileEntries)
  view.setUint8(96, 1)
  view.setUint8(97, COMPRESSION.GZIP)
  view.setUint8(98, COMPRESSION.GZIP)
  view.setUint8(99, TILE_TYPE.MVT)
  view.setUint8(100, minZoom)
  view.setUint8(101, maxZoom)
  writeScaledCoordinate(view, 102, bounds.minLon)
  writeScaledCoordinate(view, 106, bounds.minLat)
  writeScaledCoordinate(view, 110, bounds.maxLon)
  writeScaledCoordinate(view, 114, bounds.maxLat)
  view.setUint8(118, minZoom)
  writeScaledCoordinate(view, 119, (bounds.minLon + bounds.maxLon) / 2)
  writeScaledCoordinate(view, 123, (bounds.minLat + bounds.maxLat) / 2)
  return header
}

function buildDirectories(entries) {
  if (entries.length <= MAX_LEAF_ENTRIES) {
    return {
      rootDirectory: gzipSync(serializeDirectory(entries)),
      leafDirectories: [],
    }
  }

  const rootEntries = []
  const leafDirectories = []
  let leafOffset = 0
  for (let index = 0; index < entries.length; index += MAX_LEAF_ENTRIES) {
    const leafEntries = entries.slice(index, index + MAX_LEAF_ENTRIES)
    const leafDirectory = gzipSync(serializeDirectory(leafEntries))
    rootEntries.push({
      tileId: leafEntries[0].tileId,
      offset: leafOffset,
      length: leafDirectory.byteLength,
      runLength: 0,
    })
    leafDirectories.push(leafDirectory)
    leafOffset += leafDirectory.byteLength
  }

  return {
    rootDirectory: gzipSync(serializeDirectory(rootEntries)),
    leafDirectories,
  }
}

function tileCoordinates(tileIndex, minZoom, maxZoom) {
  const coords = tileIndex.tileIndex?.tileCoords || []
  return coords
    .filter(({ z }) => z >= minZoom && z <= maxZoom)
    .sort((a, b) => zxyToTileId(a.z, a.x, a.y) - zxyToTileId(b.z, b.x, b.y))
}

async function buildTileset(name, config) {
  const collection = JSON.parse(await fs.readFile(config.input, 'utf8'))
  const bounds = boundsForFeatureCollection(collection)
  const tileIndex = new GeoJSONVT(collection, {
    ...TILE_OPTIONS,
    maxZoom: config.maxZoom,
    indexMaxZoom: config.maxZoom,
    promoteId: config.nameProp,
  })
  const coords = tileCoordinates(tileIndex, config.minZoom, config.maxZoom)
  const entries = []
  const tileBuffers = []
  let offset = 0

  for (const coord of coords) {
    const tile = tileIndex.getTile(coord.z, coord.x, coord.y)
    if (!tile || tile.features.length === 0) continue

    const mvt = fromGeojsonVt({ [config.layer]: tile }, MVT_OPTIONS)
    const compressed = gzipSync(mvt)
    entries.push({
      tileId: zxyToTileId(coord.z, coord.x, coord.y),
      offset,
      length: compressed.byteLength,
      runLength: 1,
    })
    tileBuffers.push(compressed)
    offset += compressed.byteLength
  }

  const metadata = gzipSync(
    new TextEncoder().encode(
      JSON.stringify({
        name,
        version: '1',
        description: `${name} fill polygons generated from ${config.input}`,
        vector_layers: [
          {
            id: config.layer,
            fields: {
              [config.nameProp]: 'String',
            },
          },
        ],
      }),
    ),
  )
  const { rootDirectory, leafDirectories } = buildDirectories(entries)
  const leafDirectoryLength = leafDirectories.reduce((sum, leaf) => sum + leaf.byteLength, 0)
  const rootDirectoryOffset = HEADER_SIZE_BYTES
  const jsonMetadataOffset = rootDirectoryOffset + rootDirectory.byteLength
  const leafDirectoryOffset = jsonMetadataOffset + metadata.byteLength
  const tileDataOffset = leafDirectoryOffset + leafDirectoryLength
  const header = writeHeader({
    rootDirectoryOffset,
    rootDirectoryLength: rootDirectory.byteLength,
    jsonMetadataOffset,
    jsonMetadataLength: metadata.byteLength,
    leafDirectoryOffset,
    leafDirectoryLength,
    tileDataOffset,
    tileDataLength: offset,
    numAddressedTiles: entries.length,
    numTileEntries: entries.length,
    bounds,
    minZoom: config.minZoom,
    maxZoom: config.maxZoom,
  })

  await fs.writeFile(
    config.output,
    Buffer.concat([header, rootDirectory, metadata, ...leafDirectories, ...tileBuffers]),
  )
  console.log(
    `${config.output}: ${entries.length.toLocaleString()} tiles, ${(
      (HEADER_SIZE_BYTES + rootDirectory.byteLength + metadata.byteLength + offset) /
      1024 /
      1024
    ).toFixed(1)} MB`,
  )
}

for (const [name, config] of Object.entries(TILESETS)) {
  await buildTileset(name, config)
}
