import type { EthnicityCounts, EuropeanMetric, RegionData, RegionEntry } from './types'

export function normalizeName(name: string): string {
  if (!name) return ''
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

export function buildNameIndex(regionData: RegionData): Map<string, string> {
  const index = new Map<string, string>()
  for (const key of Object.keys(regionData)) {
    index.set(normalizeName(key), key)
  }
  return index
}

export function findRegionData(
  regionData: RegionData,
  regionName: string,
  nameIndex?: Map<string, string>,
): RegionEntry | null {
  if (!regionName) return null
  if (regionData[regionName]) return regionData[regionName]

  if (nameIndex) {
    const key = nameIndex.get(normalizeName(regionName))
    return key ? (regionData[key] ?? null) : null
  }

  const normalized = normalizeName(regionName)
  for (const key of Object.keys(regionData)) {
    if (normalizeName(key) === normalized) return regionData[key]
  }
  return null
}

import { SA2_ZOOM_THRESHOLD, TA_ZOOM_THRESHOLD } from './types'

export function getEuropeanData(
  regionEntry: RegionEntry | null,
  year: string,
  ageGroup = 'Total - age',
): EuropeanMetric | null {
  if (!regionEntry || !year) return null
  const yearData = regionEntry.ethnicityData[year]
  if (!yearData) return null
  const ageData = yearData[ageGroup] || yearData['Total - age']
  if (!ageData) return null

  const total = ageData['Total stated - ethnicity']
  if (typeof total !== 'number' || total <= 0) return null

  const european = ageData['European only'] || 0
  return {
    count: european,
    percentage: (european / total) * 100,
  }
}

export function europeanFillColor(percentage?: number): string {
  if (percentage === undefined || Number.isNaN(percentage)) {
    return '#888'
  }

  const value = Math.max(0, Math.min(100, percentage))
  const stops = [
    { pct: 0, color: [140, 81, 10] },
    { pct: 25, color: [216, 179, 101] },
    { pct: 50, color: [246, 232, 170] },
    { pct: 75, color: [116, 173, 209] },
    { pct: 100, color: [33, 102, 172] },
  ] as const

  for (let index = 1; index < stops.length; index++) {
    const start = stops[index - 1]
    const end = stops[index]
    if (value <= end.pct) {
      const t = (value - start.pct) / (end.pct - start.pct)
      return interpolateRgb(start.color, end.color, t)
    }
  }

  return interpolateRgb(stops[stops.length - 1].color, stops[stops.length - 1].color, 0)
}

function interpolateRgb(
  start: readonly [number, number, number],
  end: readonly [number, number, number],
  t: number,
) {
  return `rgb(${start.map((channel, index) => Math.round(channel + (end[index] - channel) * t)).join(', ')})`
}

export function getValue(data: EthnicityCounts | undefined, key: string): number {
  return data?.[key] ?? 0
}

export function ageGroupSlug(ageGroup: string): string {
  if (ageGroup === 'Total - age') return 'all'
  return ageGroup.replace(/\s+/g, '-').toLowerCase()
}

export function tierForZoom(zoom: number): 'rc' | 'ta' | 'sa2' {
  if (zoom >= SA2_ZOOM_THRESHOLD) return 'sa2'
  if (zoom >= TA_ZOOM_THRESHOLD) return 'ta'
  return 'rc'
}
