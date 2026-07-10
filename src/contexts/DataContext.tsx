import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ageGroupSlug } from '../domain/geo'
import {
  AGE_GROUPS,
  type AgeGroup,
  type GeographyTier,
  NATIONAL_KEY,
  type RegionData,
  type UnifiedData,
} from '../domain/types'
import {
  type AreaDetail,
  type DataManifest,
  loadAreaBySlug,
  loadManifest,
  loadMetrics,
  loadNameIndex,
  loadNational,
  type NameIndexEntry,
  resolveIndexEntry,
} from '../services/dataLoader'

interface DataContextType {
  selectedArea: string
  setSelectedArea: (area: string) => void
  selectedYear: string
  setSelectedYear: (year: string) => void
  selectedAgeGroup: AgeGroup
  setSelectedAgeGroup: (age: AgeGroup) => void
  availableYears: string[]
  availableAgeGroups: AgeGroup[]
  metrics: Record<string, number>
  nameIndex: Map<string, NameIndexEntry>
  loading: boolean
  detailLoading: boolean
  error: string | null
  ensureMetrics: (tiers: GeographyTier[], year?: string, ageGroup?: AgeGroup) => Promise<void>
  nationalKey: string
  nationalDetail: AreaDetail | null
  manifest: DataManifest | null
  selectedDetail: AreaDetail | null
  regionData: RegionData
  unifiedData: UnifiedData
}

const DataContext = createContext<DataContextType | undefined>(undefined)
const YEAR_QUERY_PARAM = 'year'
const AGE_QUERY_PARAM = 'age'

function metricsKey(tier: GeographyTier, year: string, age: string) {
  return `${tier}|${year}|${age}`
}

function initialSearchParams() {
  if (typeof window === 'undefined') return new URLSearchParams()
  return new URLSearchParams(window.location.search)
}

function ageGroupFromSlug(slug: string | null, availableAgeGroups: AgeGroup[]) {
  if (!slug) return null
  return availableAgeGroups.find((ageGroup) => ageGroupSlug(ageGroup) === slug) ?? null
}

export function useData() {
  const context = useContext(DataContext)
  if (!context) throw new Error('useData must be used within a DataProvider')
  return context
}

export function DataProvider({ children }: { children: ReactNode }) {
  const initialUrlYear = useMemo(() => initialSearchParams().get(YEAR_QUERY_PARAM), [])
  const initialUrlAge = useMemo(() => initialSearchParams().get(AGE_QUERY_PARAM), [])
  const initialAgeGroup = ageGroupFromSlug(initialUrlAge, AGE_GROUPS)
  const [metricsByKey, setMetricsByKey] = useState<Record<string, Record<string, number>>>({})
  const metricsLoadedRef = useRef<Set<string>>(new Set())
  const areaCacheRef = useRef<Map<string, AreaDetail>>(new Map())

  const [nameIndex, setNameIndex] = useState<Map<string, NameIndexEntry>>(new Map())
  const [manifest, setManifest] = useState<DataManifest | null>(null)
  const [selectedArea, setSelectedArea] = useState(NATIONAL_KEY)
  const [selectedYear, setSelectedYear] = useState(initialUrlYear || '2023')
  const [selectedAgeGroup, setSelectedAgeGroup] = useState<AgeGroup>(
    initialAgeGroup || 'Total - age',
  )
  const [selectedDetail, setSelectedDetail] = useState<AreaDetail | null>(null)
  const [nationalDetail, setNationalDetail] = useState<AreaDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeMetricTiers, setActiveMetricTiers] = useState<GeographyTier[]>(['rc'])

  const ensureMetrics = useCallback(
    async (tiers: GeographyTier[], year = selectedYear, ageGroup = selectedAgeGroup) => {
      setActiveMetricTiers(tiers)
      if (!year) return

      const missing = tiers.filter(
        (tier) => !metricsLoadedRef.current.has(metricsKey(tier, year, ageGroup)),
      )
      if (missing.length === 0) return

      const results = await Promise.all(
        missing.map(async (tier) => {
          const data = await loadMetrics(tier, year, ageGroup)
          return { tier, data }
        }),
      )

      for (const r of results) {
        metricsLoadedRef.current.add(metricsKey(r.tier, year, ageGroup))
      }

      setMetricsByKey((prev) => {
        const next = { ...prev }
        for (const r of results) {
          next[metricsKey(r.tier, year, ageGroup)] = r.data
        }
        return next
      })
    },
    [selectedYear, selectedAgeGroup],
  )

  // Bootstrap: manifest + name index + national detail + RC metrics
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const [man, index, national] = await Promise.all([
          loadManifest(),
          loadNameIndex(),
          loadNational(),
        ])
        if (cancelled) return
        setManifest(man)
        setNameIndex(index)
        setNationalDetail(national)
        areaCacheRef.current.set(national.name, national)
        setSelectedDetail(national)
        setSelectedArea(man.nationalKey || NATIONAL_KEY)
        const urlAgeGroup = ageGroupFromSlug(
          initialUrlAge,
          (man.ageGroups as AgeGroup[]) ?? AGE_GROUPS,
        )
        const year =
          initialUrlYear && man.years.includes(initialUrlYear)
            ? initialUrlYear
            : man.years[man.years.length - 1] || '2023'
        const ageGroup = urlAgeGroup || 'Total - age'
        setSelectedYear(year)
        setSelectedAgeGroup(ageGroup)
        const rcMetrics = await loadMetrics('rc', year, ageGroup)
        if (cancelled) return
        metricsLoadedRef.current.add(metricsKey('rc', year, ageGroup))
        setMetricsByKey({ [metricsKey('rc', year, ageGroup)]: rcMetrics })
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load data')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [initialUrlAge, initialUrlYear])

  // Reload metrics when year/age changes for active tiers
  useEffect(() => {
    if (loading) return
    void ensureMetrics(activeMetricTiers)
  }, [loading, ensureMetrics, activeMetricTiers])

  // Load area detail on selection (~40KB)
  useEffect(() => {
    let cancelled = false
    const areaName = selectedArea
    if (!areaName) return

    const cached = areaCacheRef.current.get(areaName)
    if (cached) {
      setSelectedDetail(cached)
      return
    }

    // Try name index; fall back to national
    const entry = resolveIndexEntry(nameIndex, areaName)
    if (!entry && nameIndex.size === 0) return

    ;(async () => {
      setDetailLoading(true)
      try {
        let detail: AreaDetail
        if (entry) {
          detail = await loadAreaBySlug(entry.slug)
        } else if (manifest?.nationalSlug) {
          detail = await loadAreaBySlug(manifest.nationalSlug)
        } else {
          detail = await loadNational()
        }
        if (cancelled) return
        areaCacheRef.current.set(detail.name, detail)
        // Also cache under the selected label if different
        areaCacheRef.current.set(areaName, detail)
        setSelectedDetail(detail)
      } catch (err) {
        console.error('Failed to load area detail', err)
        if (!cancelled) {
          // Keep previous detail rather than blanking panel
        }
      } finally {
        if (!cancelled) setDetailLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [selectedArea, nameIndex, manifest])

  const metrics = useMemo(() => {
    const parts: Record<string, number>[] = []
    for (const tier of activeMetricTiers) {
      const key = metricsKey(tier, selectedYear, selectedAgeGroup)
      if (metricsByKey[key]) parts.push(metricsByKey[key])
    }
    return Object.assign({}, ...parts)
  }, [activeMetricTiers, metricsByKey, selectedYear, selectedAgeGroup])

  const regionData = useMemo<RegionData>(() => {
    if (!selectedDetail) return {}
    return { [selectedDetail.name]: selectedDetail.single }
  }, [selectedDetail])

  const unifiedData = useMemo<UnifiedData>(() => {
    if (!selectedDetail) {
      return { detailedSingle: {}, level3: {} }
    }
    return {
      detailedSingle: { [selectedDetail.name]: selectedDetail.single },
      level3: selectedDetail.level3 ? { [selectedDetail.name]: selectedDetail.level3 } : {},
    }
  }, [selectedDetail])

  const availableYears = manifest?.years ?? ['2013', '2018', '2023']
  const availableAgeGroups = (manifest?.ageGroups as AgeGroup[]) ?? AGE_GROUPS

  const value: DataContextType = {
    selectedArea,
    setSelectedArea,
    selectedYear,
    setSelectedYear,
    selectedAgeGroup,
    setSelectedAgeGroup,
    availableYears,
    availableAgeGroups,
    metrics,
    nameIndex,
    loading,
    detailLoading,
    error,
    ensureMetrics,
    nationalKey: manifest?.nationalKey ?? NATIONAL_KEY,
    nationalDetail,
    manifest,
    selectedDetail,
    regionData,
    unifiedData,
  }

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useSelectedRegionData() {
  const { selectedDetail } = useData()
  return selectedDetail?.single ?? null
}
