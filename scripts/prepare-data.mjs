/**
 * Prepare slim static data for progressive loading:
 * - metrics/{tier}/{year}-{age}.json  — choropleth only (KB)
 * - areas/{slug}.json                 — full detail for one place (~40KB)
 * - national.json                     — NZ totals for default panel
 * - name-index.json                   — normalize → { name, slug, tier, center }
 * - search-index.json                 — compact list for typeahead
 * - manifest.json
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const publicData = join(root, 'public', 'data')
const outRoot = join(publicData, 'prepared')

const AGE_GROUPS = [
  'Total - age',
  'Under 15 years',
  '15-29 years',
  '30-64 years',
  '65 years and over',
]

const YEARS = ['2013', '2018', '2023']
// Suppress percentages based on too few stated ethnicity responses to be meaningful.
const MINIMUM_STATED_ETHNICITY_COUNT = 50

function normalizeName(name) {
  if (!name) return ''
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function slugify(name) {
  const base = normalizeName(name)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'unknown'
}

function buildNameIndex(regionData) {
  const index = new Map()
  for (const key of Object.keys(regionData)) {
    index.set(normalizeName(key), key)
  }
  return index
}

function lookupRegion(regionData, nameIndex, name) {
  if (regionData[name]) return regionData[name]
  const key = nameIndex.get(normalizeName(name))
  return key ? regionData[key] : null
}

function europeanPct(ageData) {
  if (!ageData) return null
  const total = ageData['Total stated - ethnicity']
  if (typeof total !== 'number' || total < MINIMUM_STATED_ETHNICITY_COUNT) return null
  const european = ageData['European only'] || 0
  return Math.round((european / total) * 1000) / 10
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(data))
}

/**
 * Map names as they appear on the map (GeoJSON) → census keys when different.
 * The GeoJSON layers name Auckland simply "Auckland" for both RC and TA, but
 * Stats NZ stores the complete data under the "Auckland Region" key (geoid 02).
 * The bare "Auckland" key (geoid 076, TA) has incomplete ethnicity breakdowns,
 * so we alias display name "Auckland" → census key "Auckland Region".
 */
const CENSUS_ALIASES = {
  Auckland: 'Auckland Region',
}

function resolveCensusName(displayName, nameIndex) {
  const alias = CENSUS_ALIASES[displayName]
  if (alias && nameIndex.has(normalizeName(alias))) return nameIndex.get(normalizeName(alias))
  if (nameIndex.has(normalizeName(displayName))) return nameIndex.get(normalizeName(displayName))
  return null
}

function ringBounds(ring, bounds) {
  for (const coord of ring) {
    const [x, y] = coord
    if (x < bounds.minX) bounds.minX = x
    if (y < bounds.minY) bounds.minY = y
    if (x > bounds.maxX) bounds.maxX = x
    if (y > bounds.maxY) bounds.maxY = y
  }
}

/** Approximate centroid as bbox centre [lng, lat] for flyTo. */
function featureCenter(feature) {
  const geometry = feature.geometry
  if (!geometry) return null
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  }
  if (geometry.type === 'Polygon') {
    ringBounds(geometry.coordinates[0], bounds)
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates) {
      ringBounds(polygon[0], bounds)
    }
  } else {
    return null
  }
  if (!Number.isFinite(bounds.minX)) return null
  return [
    Math.round(((bounds.minX + bounds.maxX) / 2) * 1e5) / 1e5,
    Math.round(((bounds.minY + bounds.maxY) / 2) * 1e5) / 1e5,
  ]
}

function centersFromGeo(geo, nameProp) {
  const map = new Map()
  for (const feature of geo.features) {
    const name = feature.properties?.[nameProp]
    if (!name) continue
    const center = featureCenter(feature)
    if (center) map.set(name, center)
  }
  return map
}

function tierNamesFromGeo(rcGeo, taGeo, sa2Geo) {
  return {
    rc: rcGeo.features.map((f) => f.properties.REGC2025_1).filter(Boolean),
    ta: taGeo.features.map((f) => f.properties.TA2025_V_1).filter(Boolean),
    sa2: sa2Geo.features.map((f) => f.properties.SA22025__2).filter(Boolean),
  }
}

function pickYears(entry) {
  if (!entry?.ethnicityData) return null
  const ethnicityData = {}
  for (const year of YEARS) {
    if (entry.ethnicityData[year]) ethnicityData[year] = entry.ethnicityData[year]
  }
  return Object.keys(ethnicityData).length > 0 ? { ethnicityData } : null
}

async function main() {
  console.log('Loading source data...')
  const assets = join(root, 'src', 'assets')
  const [single, level3, dims, rcGeo, taGeo, sa2Geo] = await Promise.all([
    loadJson(join(publicData, 'statsnz_census_data.json')),
    loadJson(join(publicData, 'statsnz_census_data_level3.json')),
    loadJson(join(publicData, 'statsnz_dimensions.json')),
    loadJson(join(assets, 'regional-councils.json')),
    loadJson(join(assets, 'territorial-authorities.json')),
    loadJson(join(assets, 'statistical-area-2.json')),
  ])

  // Wipe previous prepared output subdirectories (keeps prepared/ root intact
  // so Vite's sirv cache doesn't lose track of root-level files)
  for (const sub of ['areas', 'metrics']) {
    await rm(join(outRoot, sub), { recursive: true, force: true })
  }
  await mkdir(outRoot, { recursive: true })

  const singleIndex = buildNameIndex(single)
  const level3Index = buildNameIndex(level3)
  // Use map geometry names so metrics keys match PMTiles feature properties
  const namesByTier = tierNamesFromGeo(rcGeo, taGeo, sa2Geo)
  const centersByTier = {
    rc: centersFromGeo(rcGeo, 'REGC2025_1'),
    ta: centersFromGeo(taGeo, 'TA2025_V_1'),
    sa2: centersFromGeo(sa2Geo, 'SA22025__2'),
  }

  const nationalKeys = [
    'Total - New Zealand by regional council',
    'Total - New Zealand by territorial authority and Auckland local board/SA2',
  ]

  const nameIndexOut = {}
  const searchEntries = []
  const usedSlugs = new Map()
  let areaCount = 0

  async function writeArea(displayName, tier) {
    const censusKey = resolveCensusName(displayName, singleIndex)
    if (!censusKey) return null
    const singleEntry = pickYears(single[censusKey])
    if (!singleEntry) return null

    const level3Key = resolveCensusName(displayName, level3Index) || censusKey
    const level3Entry = pickYears(
      level3[level3Key] || lookupRegion(level3, level3Index, displayName),
    )
    let slug = slugify(displayName)
    if (usedSlugs.has(slug) && usedSlugs.get(slug) !== displayName) {
      slug = `${slug}-${tier}`
    }
    usedSlugs.set(slug, displayName)

    const center = centersByTier[tier]?.get(displayName) || null

    await writeJson(join(outRoot, 'areas', `${slug}.json`), {
      name: displayName,
      tier,
      single: singleEntry,
      level3: level3Entry,
    })

    const entry = {
      name: displayName,
      slug,
      tier,
      center,
    }
    nameIndexOut[normalizeName(displayName)] = entry
    // Also index the census key when it differs (e.g. Auckland)
    if (normalizeName(censusKey) !== normalizeName(displayName)) {
      nameIndexOut[normalizeName(censusKey)] = entry
    }
    if (tier !== 'national') {
      searchEntries.push({
        n: displayName,
        s: slug,
        t: tier,
        c: center,
      })
    }
    areaCount++
    return slug
  }

  for (const tier of ['rc', 'ta', 'sa2']) {
    console.log(`Writing metrics + areas for ${tier} (${namesByTier[tier].length} features)...`)
    for (const year of YEARS) {
      for (const age of AGE_GROUPS) {
        const metrics = {}
        for (const name of namesByTier[tier]) {
          const censusKey = resolveCensusName(name, singleIndex)
          if (!censusKey) continue
          const ageData = single[censusKey]?.ethnicityData?.[year]?.[age]
          const pct = europeanPct(ageData)
          // Key by map display name so MapLibre match expressions work
          if (pct !== null) metrics[name] = pct
        }
        const slug = age === 'Total - age' ? 'all' : age.replace(/\s+/g, '-').toLowerCase()
        await writeJson(join(outRoot, 'metrics', tier, `${year}-${slug}.json`), metrics)
      }
    }

    for (const name of namesByTier[tier]) {
      await writeArea(name, tier)
    }
  }

  for (const name of nationalKeys) {
    await writeArea(name, 'national')
  }

  const nationalName = 'Total - New Zealand by regional council'
  const nationalSingle = pickYears(single[nationalName])
  const nationalLevel3 = pickYears(level3[nationalName])
  await writeJson(join(outRoot, 'national.json'), {
    name: nationalName,
    tier: 'national',
    single: nationalSingle,
    level3: nationalLevel3,
  })

  // Prefer SA2 over TA over RC when ranking search (more specific first in list order)
  const tierOrder = { sa2: 0, ta: 1, rc: 2 }
  searchEntries.sort((a, b) => {
    const td = (tierOrder[a.t] ?? 9) - (tierOrder[b.t] ?? 9)
    if (td !== 0) return td
    return a.n.localeCompare(b.n)
  })

  await writeJson(join(outRoot, 'name-index.json'), nameIndexOut)
  await writeJson(join(outRoot, 'search-index.json'), searchEntries)
  await writeJson(join(outRoot, 'manifest.json'), {
    years: YEARS,
    ageGroups: AGE_GROUPS,
    tiers: ['rc', 'ta', 'sa2'],
    nationalKey: nationalName,
    nationalSlug:
      nameIndexOut[normalizeName(nationalName)]?.slug || 'total-new-zealand-by-regional-council',
    ethnicities: dims.ethnicities || {},
    areaCount,
    searchCount: searchEntries.length,
    preparedAt: new Date().toISOString(),
  })

  console.log(
    `Done → ${areaCount} area files, ${searchEntries.length} search entries in public/data/prepared/`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
