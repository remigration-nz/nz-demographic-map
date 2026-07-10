import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import { useEffect, useRef, useState } from 'react'
import 'maplibre-gl/dist/maplibre-gl.css'
import AreaSearch, { type SearchHit } from './AreaSearch'
import ControlPanel from './ControlPanel'
import { useData } from './contexts/DataContext'
import { useTheme } from './contexts/ThemeContext'
import { europeanFillColor, getEuropeanData } from './domain/geo'
import {
  type GeographyTier,
  SA2_ZOOM_THRESHOLD,
  TA_ZOOM_THRESHOLD,
  TILE_SOURCES,
} from './domain/types'
import InfoPanel from './InfoPanel'
import { pmtilesUrl } from './lib/paths'
import MapLegend from './MapLegend'

const NZ_CENTER: [number, number] = [174.7762, -41.2865]
// Wide enough for all of NZ including Chathams when fitting the national view.
const NZ_FIT_BOUNDS: [[number, number], [number, number]] = [
  [160.0, -50.0],
  [185.0, -32.0],
]
const NZ_NAVIGATION_BOUNDS: [[number, number], [number, number]] = [
  [130.0, -65.0],
  [210.0, -15.0],
]
const NZ_FIT_PADDING = 32
const GEOGRAPHY_TIERS: GeographyTier[] = ['rc', 'ta', 'sa2']
const MAP_BACKGROUND = {
  light: '#eef2f1',
  dark: '#101820',
} as const
const pmtilesProtocol = new Protocol()
let pmtilesProtocolRegistered = false

function ensurePmtilesProtocol() {
  if (pmtilesProtocolRegistered) return
  try {
    maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.toLowerCase().includes('already')) throw error
  }
  pmtilesProtocolRegistered = true
}

function hasFineHoverPointer() {
  return (
    typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches
  )
}

function ensureFillLayer(map: maplibregl.Map, tier: GeographyTier) {
  if (!map.getSource(tier)) {
    map.addSource(tier, {
      type: 'vector',
      url: `pmtiles://${pmtilesUrl(`tiles/${tier}.pmtiles`)}`,
      promoteId: TILE_SOURCES[tier].nameProp,
    })
  }
  if (!map.getLayer(`${tier}-fill`)) {
    map.addLayer({
      id: `${tier}-fill`,
      type: 'fill',
      source: tier,
      'source-layer': TILE_SOURCES[tier].layer,
      paint: {
        'fill-color': hoverColorExpression('#888'),
        'fill-antialias': false,
      },
    })
  }
}

function ensureBorderLayer(map: maplibregl.Map, tier: GeographyTier) {
  const layerId = `${tier}-border`
  if (!map.getLayer(layerId)) {
    map.addLayer({
      id: layerId,
      type: 'line',
      source: tier,
      'source-layer': TILE_SOURCES[tier].layer,
      paint: {
        'line-color': borderColorForFill('#888'),
        'line-width': borderLineWidth(tier),
      },
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
    })
  }
}

function ensureTierLayers(map: maplibregl.Map, tier: GeographyTier) {
  ensureFillLayer(map, tier)
  ensureBorderLayer(map, tier)
}

function ensureNationalLayers(map: maplibregl.Map) {
  if (!map.getSource('national')) {
    map.addSource('national', {
      type: 'vector',
      url: `pmtiles://${pmtilesUrl('tiles/national.pmtiles')}`,
      promoteId: 'name',
    })
  }
  if (!map.getLayer('national-fill')) {
    map.addLayer({
      id: 'national-fill',
      type: 'fill',
      source: 'national',
      'source-layer': 'national',
      paint: {
        'fill-color': hoverColorExpression('#888'),
        'fill-antialias': false,
      },
    })
  }
  if (!map.getLayer('national-border')) {
    map.addLayer({
      id: 'national-border',
      type: 'line',
      source: 'national',
      'source-layer': 'national',
      paint: {
        'line-color': borderColorForFill('#888'),
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.5, 6, 0.9, 9, 1.2],
      },
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
    })
  }
}

function removeLayerIfPresent(map: maplibregl.Map, layerId: string) {
  if (map.getLayer(layerId)) map.removeLayer(layerId)
}

function removeSourceIfPresent(map: maplibregl.Map, sourceId: string) {
  if (map.getSource(sourceId)) map.removeSource(sourceId)
}

function removeTierLayers(map: maplibregl.Map, tier: GeographyTier) {
  removeLayerIfPresent(map, `${tier}-border`)
  removeLayerIfPresent(map, `${tier}-fill`)
  removeSourceIfPresent(map, tier)
}

function removeNationalLayers(map: maplibregl.Map) {
  removeLayerIfPresent(map, 'national-border')
  removeLayerIfPresent(map, 'national-fill')
  removeSourceIfPresent(map, 'national')
}

function fitNzBounds(map: maplibregl.Map, duration = 0) {
  map.fitBounds(NZ_FIT_BOUNDS, {
    padding: NZ_FIT_PADDING,
    duration,
  })
}

function borderLineWidth(tier: GeographyTier): maplibregl.ExpressionSpecification {
  if (tier === 'rc') {
    return ['interpolate', ['linear'], ['zoom'], 2, 0.35, 5, 0.65, 8, 1]
  }
  if (tier === 'ta') {
    return ['interpolate', ['linear'], ['zoom'], 8, 0.5, 10, 0.8, 11, 1]
  }
  return ['interpolate', ['linear'], ['zoom'], 11, 0.35, 12, 0.5, 14, 0.7]
}

function colorExpression(
  metrics: Record<string, number>,
  nameProp: string,
): maplibregl.ExpressionSpecification {
  return metricColorExpression(metrics, nameProp, (color) => color, lightenColor)
}

function borderColorExpression(
  metrics: Record<string, number>,
  nameProp: string,
): maplibregl.ExpressionSpecification {
  return metricColorExpression(metrics, nameProp, darkenColor, (color) =>
    darkenColor(lightenColor(color)),
  )
}

function borderColorForFill(color: string): maplibregl.ExpressionSpecification {
  return hoverColorExpression(darkenColor(color), darkenColor(lightenColor(color)))
}

function metricColorExpression(
  metrics: Record<string, number>,
  nameProp: string,
  baseColor: (color: string) => string,
  hoverColor: (color: string) => string,
): maplibregl.ExpressionSpecification {
  const entries = Object.entries(metrics)
  if (entries.length === 0) return hoverColorExpression(baseColor('#888'), hoverColor('#888'))

  const matchExpr: unknown[] = ['match', ['get', nameProp]]
  const hoverMatchExpr: unknown[] = ['match', ['get', nameProp]]
  for (const [name, pct] of entries) {
    const color = europeanFillColor(pct)
    matchExpr.push(name, baseColor(color))
    hoverMatchExpr.push(name, hoverColor(color))
  }
  matchExpr.push(baseColor('#888'))
  hoverMatchExpr.push(hoverColor('#888'))
  return hoverColorExpression(
    matchExpr as maplibregl.ExpressionSpecification,
    hoverMatchExpr as maplibregl.ExpressionSpecification,
  )
}

function hoverColorExpression(
  baseColor: string | maplibregl.ExpressionSpecification,
  hoverColor: string | maplibregl.ExpressionSpecification = typeof baseColor === 'string'
    ? lightenColor(baseColor)
    : baseColor,
): maplibregl.ExpressionSpecification {
  return [
    'case',
    ['boolean', ['feature-state', 'hover'], false],
    typeof hoverColor === 'string' ? ['literal', hoverColor] : hoverColor,
    typeof baseColor === 'string' ? ['literal', baseColor] : baseColor,
  ]
}

function lightenColor(color: string, amount = 0.16): string {
  const channels = parseColor(color)
  if (!channels) return color
  const [red, green, blue] = channels
  return `rgb(${lightenChannel(red, amount)}, ${lightenChannel(green, amount)}, ${lightenChannel(
    blue,
    amount,
  )})`
}

function lightenChannel(value: number, amount: number) {
  return Math.round(value + (255 - value) * amount)
}

function darkenColor(color: string, amount = 0.24): string {
  const channels = parseColor(color)
  if (!channels) return color
  const [red, green, blue] = channels
  return `rgb(${darkenChannel(red, amount)}, ${darkenChannel(green, amount)}, ${darkenChannel(
    blue,
    amount,
  )})`
}

function darkenChannel(value: number, amount: number) {
  return Math.round(value * (1 - amount))
}

function parseColor(color: string): [number, number, number] | null {
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const value =
      hex[1].length === 3
        ? hex[1]
            .split('')
            .map((character) => character + character)
            .join('')
        : hex[1]
    return [
      Number.parseInt(value.slice(0, 2), 16),
      Number.parseInt(value.slice(2, 4), 16),
      Number.parseInt(value.slice(4, 6), 16),
    ]
  }

  const rgb = color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/)
  if (!rgb) return null
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
}

interface HoveredFeature {
  source: string
  sourceLayer?: string
  id: string | number
}

function clearHoveredFeature(map: maplibregl.Map, hoveredFeature: HoveredFeature | null) {
  if (!hoveredFeature) return
  if (!map.getSource(hoveredFeature.source)) return
  map.setFeatureState(hoveredFeature, { hover: false })
}

function activeGeographyTier(
  zoom: number,
  showRegionalCouncils: boolean,
  showTerritorialAuthorities: boolean,
  showSA2: boolean,
): GeographyTier | null {
  const showRc =
    showRegionalCouncils &&
    (zoom < TA_ZOOM_THRESHOLD ||
      (!showTerritorialAuthorities && zoom < SA2_ZOOM_THRESHOLD) ||
      (!showTerritorialAuthorities && !showSA2))
  const showTa =
    showTerritorialAuthorities &&
    zoom >= TA_ZOOM_THRESHOLD &&
    (zoom < SA2_ZOOM_THRESHOLD || !showSA2)
  const showSa2Layer = showSA2 && zoom >= SA2_ZOOM_THRESHOLD

  if (showSa2Layer) return 'sa2'
  if (showTa) return 'ta'
  if (showRc) return 'rc'
  if (showTerritorialAuthorities) return 'ta'
  if (showSA2) return 'sa2'
  return null
}

function tierFromFillLayer(layerId: string): GeographyTier | 'national' | null {
  if (layerId === 'national-fill') return 'national'
  if (layerId === 'rc-fill') return 'rc'
  if (layerId === 'ta-fill') return 'ta'
  if (layerId === 'sa2-fill') return 'sa2'
  return null
}

function loadedFillLayers(map: maplibregl.Map) {
  return ['national-fill', 'rc-fill', 'ta-fill', 'sa2-fill'].filter((layerId) =>
    map.getLayer(layerId),
  )
}

function MapView() {
  const {
    setSelectedArea,
    selectedYear,
    setSelectedYear,
    selectedAgeGroup,
    setSelectedAgeGroup,
    availableYears,
    availableAgeGroups,
    metrics,
    loading,
    error,
    ensureMetrics,
    nationalKey,
    nationalDetail,
    detailLoading,
  } = useData()
  const { theme } = useTheme()

  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [zoomLevel, setZoomLevel] = useState(6)
  const [mapReady, setMapReady] = useState(false)
  const [showRegionalCouncils, setShowRegionalCouncils] = useState(true)
  const [showTerritorialAuthorities, setShowTerritorialAuthorities] = useState(true)
  const [showSA2, setShowSA2] = useState(true)
  const activeTier = activeGeographyTier(
    zoomLevel,
    showRegionalCouncils,
    showTerritorialAuthorities,
    showSA2,
  )

  // Init map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    ensurePmtilesProtocol()

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          rc: {
            type: 'vector',
            url: `pmtiles://${pmtilesUrl('tiles/rc.pmtiles')}`,
            promoteId: TILE_SOURCES.rc.nameProp,
          },
        },
        layers: [
          {
            id: 'background',
            type: 'background',
            paint: {
              'background-color': MAP_BACKGROUND.light,
            },
          },
          {
            id: 'rc-fill',
            type: 'fill',
            source: 'rc',
            'source-layer': TILE_SOURCES.rc.layer,
            paint: {
              'fill-color': hoverColorExpression('#888'),
              'fill-antialias': false,
            },
          },
        ],
      },
      center: NZ_CENTER,
      zoom: 5,
      maxBounds: NZ_NAVIGATION_BOUNDS,
      minZoom: 1,
      maxZoom: 14,
      attributionControl: false,
      fadeDuration: 0,
    })

    map.on('load', () => {
      fitNzBounds(map)
      setMapReady(true)
      setZoomLevel(map.getZoom())
    })

    map.on('zoomend', () => setZoomLevel(map.getZoom()))
    const hoverPopup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 12,
      className: 'area-hover-popup',
    })
    let hoveredFeature: HoveredFeature | null = null

    const leaveHandler = () => {
      map.getCanvas().style.cursor = ''
      clearHoveredFeature(map, hoveredFeature)
      hoveredFeature = null
      hoverPopup.remove()
    }
    const clearHoverOnTouch = (_event: TouchEvent) => {
      leaveHandler()
    }
    const clickHandler = (e: maplibregl.MapMouseEvent) => {
      const layers = loadedFillLayers(map)
      if (layers.length === 0) return
      const features = map.queryRenderedFeatures(e.point, {
        layers,
      })
      const feature = features[0]
      const tier = tierFromFillLayer(feature?.layer.id ?? '')
      if (tier === 'national') {
        setSelectedArea(nationalKey)
        leaveHandler()
        return
      }
      if (!tier) return

      const nameProp = TILE_SOURCES[tier].nameProp
      const name = feature?.properties?.[nameProp]
      if (typeof name === 'string' && name) {
        setSelectedArea(name)
      }
      leaveHandler()
    }
    const hoverHandler = (e: maplibregl.MapMouseEvent) => {
      if (!hasFineHoverPointer()) {
        leaveHandler()
        return
      }

      const layers = loadedFillLayers(map)
      if (layers.length === 0) {
        leaveHandler()
        return
      }

      const feature = map.queryRenderedFeatures(e.point, { layers })[0]
      const tier = tierFromFillLayer(feature?.layer.id ?? '')
      if (!feature || !tier) {
        leaveHandler()
        return
      }

      const nameProp = tier === 'national' ? 'name' : TILE_SOURCES[tier].nameProp
      const name = feature.properties?.[nameProp]
      if (typeof name !== 'string' || !name) {
        leaveHandler()
        return
      }

      map.getCanvas().style.cursor = 'pointer'
      if (feature.id === undefined || feature.id === null) {
        hoverPopup.setLngLat(e.lngLat).setText(name).addTo(map)
        return
      }

      const nextHoveredFeature = {
        source: tier,
        sourceLayer: tier === 'national' ? 'national' : TILE_SOURCES[tier].layer,
        id: feature.id,
      }
      if (
        hoveredFeature?.source === nextHoveredFeature.source &&
        hoveredFeature.sourceLayer === nextHoveredFeature.sourceLayer &&
        hoveredFeature.id === nextHoveredFeature.id
      ) {
        return
      }

      clearHoveredFeature(map, hoveredFeature)
      hoveredFeature = nextHoveredFeature
      map.setFeatureState(hoveredFeature, { hover: true })
      hoverPopup.setLngLat(e.lngLat).setText(name).addTo(map)
    }

    map.on('click', clickHandler)
    map.on('mousemove', hoverHandler)

    const canvas = map.getCanvas()
    canvas.addEventListener('mouseleave', leaveHandler)
    canvas.addEventListener('touchend', clearHoverOnTouch)
    canvas.addEventListener('touchcancel', clearHoverOnTouch)

    mapRef.current = map
    return () => {
      canvas.removeEventListener('mouseleave', leaveHandler)
      canvas.removeEventListener('touchend', clearHoverOnTouch)
      canvas.removeEventListener('touchcancel', clearHoverOnTouch)
      map.off('click', clickHandler)
      map.off('mousemove', hoverHandler)
      hoverPopup.remove()
      map.remove()
      mapRef.current = null
    }
  }, [setSelectedArea, nationalKey])

  // Lazy-load choropleth metrics only (KB), not full census tables
  useEffect(() => {
    void ensureMetrics(activeTier ? [activeTier] : [])
  }, [activeTier, ensureMetrics])

  // Keep only the visible geography PMTiles source loaded in MapLibre.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return

    const showNational = !showRegionalCouncils && !showTerritorialAuthorities && !showSA2
    const active = activeTier
    const nationalMetric = getEuropeanData(
      nationalDetail?.single ?? null,
      selectedYear,
      selectedAgeGroup,
    )
    const nationalFillColor = europeanFillColor(nationalMetric?.percentage)

    if (showNational) {
      ensureNationalLayers(map)
      map.setPaintProperty('national-fill', 'fill-color', hoverColorExpression(nationalFillColor))
      map.setPaintProperty('national-border', 'line-color', borderColorForFill(nationalFillColor))
    } else {
      removeNationalLayers(map)
    }

    for (const tier of GEOGRAPHY_TIERS) {
      if (active === tier) {
        ensureTierLayers(map, tier)
        const nameProp = TILE_SOURCES[tier].nameProp
        map.setPaintProperty(`${tier}-fill`, 'fill-color', colorExpression(metrics, nameProp))
        map.setPaintProperty(
          `${tier}-border`,
          'line-color',
          borderColorExpression(metrics, nameProp),
        )
      } else {
        removeTierLayers(map, tier)
      }
    }
  }, [
    activeTier,
    metrics,
    mapReady,
    nationalDetail,
    selectedAgeGroup,
    selectedYear,
    showRegionalCouncils,
    showSA2,
    showTerritorialAuthorities,
  ])

  useEffect(() => {
    const map = mapRef.current
    const container = containerRef.current
    if (!map || !container || !mapReady) return

    let frame = 0
    const resize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        map.resize()
      })
    }

    const observer = new ResizeObserver(resize)
    observer.observe(container)
    window.addEventListener('resize', resize)
    resize()

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', resize)
    }
  }, [mapReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !map.getLayer('background')) return
    map.setPaintProperty('background', 'background-color', MAP_BACKGROUND[theme])
  }, [theme, mapReady])

  const flyToSearch = (hit: SearchHit, zoom: number) => {
    setSelectedArea(hit.name)
    const map = mapRef.current
    if (!map || !hit.center) return
    map.flyTo({
      center: hit.center,
      zoom,
      essential: true,
      duration: 1200,
    })
  }

  return (
    <>
      <div style={{ position: 'absolute', inset: 0 }}>
        <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
      </div>
      <AreaSearch onSelect={flyToSearch} disabled={loading} />
      <InfoPanel
        controls={
          <ControlPanel
            availableYears={availableYears}
            selectedYear={selectedYear}
            onYearChange={setSelectedYear}
            availableAgeGroups={availableAgeGroups}
            selectedAgeGroup={selectedAgeGroup}
            onAgeGroupChange={setSelectedAgeGroup}
            showRegionalCouncils={showRegionalCouncils}
            onShowRegionalCouncilsChange={setShowRegionalCouncils}
            showTerritorialAuthorities={showTerritorialAuthorities}
            onShowTerritorialAuthoritiesChange={setShowTerritorialAuthorities}
            showSA2={showSA2}
            onShowSA2Change={setShowSA2}
            disabled={loading}
            embedded
          />
        }
      />
      <MapLegend />
      {loading && <div className="map-overlay-message">Loading map...</div>}
      {detailLoading && !loading && <div className="map-overlay-detail">Loading area...</div>}
      {error && <div className="map-overlay-error">Error: {error}</div>}
    </>
  )
}

export default MapView
