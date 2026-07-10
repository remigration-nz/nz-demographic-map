import {
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useData, useSelectedRegionData } from './contexts/DataContext'
import { useTheme } from './contexts/ThemeContext'
import { describeArc, processUnifiedData } from './domain/ethnicity'
import { ageGroupSlug } from './domain/geo'
import { AGE_GROUPS, CATEGORY_COLORS, type DisplayItem, LEVEL3_KEY_MAP } from './domain/types'
import { resolveIndexEntry } from './services/dataLoader'

interface PieSlice {
  name: string
  value: number
  color: string
  startAngle: number
  endAngle: number
}

type InfoPanelTab = 'details' | 'controls'

interface InfoPanelProps {
  controls: ReactNode
}

interface PanelDragState {
  pointerId: number
  startY: number
  startCollapsed: boolean
  moved: boolean
}

interface PanelStyle extends CSSProperties {
  '--panel-drag-offset'?: string
}

const MOBILE_PANEL_QUERY = '(max-width: 640px)'
const PANEL_DRAG_THRESHOLD = 44
const AREA_QUERY_PARAM = 'area'
const YEAR_QUERY_PARAM = 'year'
const AGE_QUERY_PARAM = 'age'
const isMobilePanelViewport = () =>
  typeof window !== 'undefined' && window.matchMedia(MOBILE_PANEL_QUERY).matches

function shareUrlForSlug(slug: string | null, year: string, ageGroup: string) {
  if (!slug || typeof window === 'undefined') return ''
  const url = new URL(window.location.href)
  url.searchParams.set(AREA_QUERY_PARAM, slug)
  url.searchParams.set(YEAR_QUERY_PARAM, year)
  url.searchParams.set(AGE_QUERY_PARAM, ageGroupSlug(ageGroup))
  return url.href
}

async function copyShareUrl(url: string) {
  if (!url) return false
  try {
    await navigator.clipboard.writeText(url)
    return true
  } catch {
    return false
  }
}

function EthnicityPie({ items, isDark }: { items: DisplayItem[]; isDark: boolean }) {
  const slices = useMemo(() => {
    const positive = items.filter((i) => i.value > 0)
    const sum = positive.reduce((s, i) => s + i.value, 0)
    if (sum <= 0) return [] as PieSlice[]

    let angle = 0
    return positive.map((item) => {
      const sweep = (item.value / sum) * 360
      const slice: PieSlice = {
        name: item.name,
        value: item.value,
        color: CATEGORY_COLORS[item.name] || '#888',
        startAngle: angle,
        endAngle: angle + sweep,
      }
      angle += sweep
      return slice
    })
  }, [items])

  if (slices.length === 0) return null

  const size = 160
  const cx = size / 2
  const cy = size / 2
  const r = 70

  return (
    <div className="pie-wrap">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-label="Ethnicity pie chart"
      >
        {slices.map((slice) => {
          if (slice.endAngle - slice.startAngle >= 359.99) {
            return <circle key={slice.name} cx={cx} cy={cy} r={r} fill={slice.color} />
          }
          return (
            <path
              key={slice.name}
              d={describeArc(cx, cy, r, slice.startAngle, slice.endAngle)}
              fill={slice.color}
              stroke={isDark ? '#333' : '#f0f0f0'}
              strokeWidth={1}
            >
              <title>{`${slice.name}: ${slice.value.toLocaleString()}`}</title>
            </path>
          )
        })}
      </svg>
      <div className="pie-legend">
        {slices.map((slice) => (
          <div key={slice.name} className="pie-legend-row">
            <span className="pie-swatch" style={{ background: slice.color }} />
            <span className="pie-legend-label">{slice.name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function AgeBreakdown({
  yearData,
  isDark,
}: {
  yearData: Record<string, Record<string, number>> | undefined
  isDark: boolean
}) {
  if (!yearData) return null

  const rows = AGE_GROUPS.filter((ag) => ag !== 'Total - age')
    .map((ag) => {
      const total = yearData[ag]?.['Total stated - ethnicity'] || 0
      const european = yearData[ag]?.['European only'] || 0
      const pct = total > 0 ? (european / total) * 100 : 0
      return { ag, total, european, pct }
    })
    .filter((r) => r.total > 0)

  if (rows.length === 0) return null

  const maxTotal = Math.max(...rows.map((r) => r.total))

  return (
    <div className="age-breakdown">
      <div className="age-breakdown-title">Age groups (European % of stated)</div>
      {rows.map((row) => (
        <div key={row.ag} className="age-bar-row">
          <span className="age-bar-label">
            {row.ag.replace(' years', '').replace(' and over', '+')}
          </span>
          <div className="age-bar-track">
            <div
              className="age-bar-fill"
              style={{
                width: `${maxTotal > 0 ? (row.total / maxTotal) * 100 : 0}%`,
                background: isDark ? '#4b5563' : '#d1d5db',
              }}
            >
              <div
                className="age-bar-euro"
                style={{ width: `${row.pct}%`, background: '#3b82f6' }}
              />
            </div>
          </div>
          <span className="age-bar-pct">{row.pct.toFixed(0)}%</span>
        </div>
      ))}
    </div>
  )
}

function InfoPanel({ controls }: InfoPanelProps) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const { selectedArea, selectedYear, selectedAgeGroup, selectedDetail, detailLoading, nameIndex } =
    useData()
  const data = useSelectedRegionData()
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState(() => isMobilePanelViewport())
  const [activeTab, setActiveTab] = useState<InfoPanelTab>('details')
  const [shareCopied, setShareCopied] = useState(false)
  const previousSelectedAreaRef = useRef(selectedArea)
  const dragStateRef = useRef<PanelDragState | null>(null)
  const suppressClickRef = useRef(false)
  const [dragOffset, setDragOffset] = useState(0)
  const [isDragging, setIsDragging] = useState(false)

  useEffect(() => {
    if (previousSelectedAreaRef.current === selectedArea) return
    previousSelectedAreaRef.current = selectedArea
    setCollapsed(false)
    setActiveTab('details')
    setShareCopied(false)
  }, [selectedArea])

  const toggleExpand = (name: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const selectedYearAgeGroupData = data?.ethnicityData?.[selectedYear]?.[selectedAgeGroup]
  const baseYearAgeGroupData = data?.ethnicityData?.['2013']?.[selectedAgeGroup]
  const total = selectedYearAgeGroupData?.['Total stated - ethnicity']
  const baseTotal = baseYearAgeGroupData?.['Total stated - ethnicity']

  const level3SelectedYearData =
    selectedDetail?.level3?.ethnicityData?.[selectedYear]?.[selectedAgeGroup]
  const selectedIndexEntry = resolveIndexEntry(nameIndex, selectedArea)
  const selectedSlug = selectedIndexEntry?.slug ?? null
  const shareUrl = shareUrlForSlug(selectedSlug, selectedYear, selectedAgeGroup)

  const isMobilePanel = isMobilePanelViewport

  const selectDrawerTab = (tab: InfoPanelTab) => {
    const mobile = isMobilePanel()

    if (mobile && activeTab === tab) return

    if (activeTab === tab) {
      setCollapsed((current) => !current)
      return
    }
    setActiveTab(tab)
    if (!mobile) setCollapsed(false)
  }

  const shareSelectedArea = async () => {
    if (!shareUrl) return
    if (navigator.share) {
      try {
        await navigator.share({
          title: selectedArea,
          url: shareUrl,
        })
        return
      } catch (error) {
        if ((error as DOMException).name === 'AbortError') return
      }
    }

    const copied = await copyShareUrl(shareUrl)
    setShareCopied(copied)
  }

  const heading = (
    <>
      <div className="info-title-row">
        <h4>{selectedArea}</h4>
      </div>
      {shareUrl && (
        <button
          type="button"
          className="info-share-button"
          onClick={shareSelectedArea}
          aria-label={`Share ${selectedArea}`}
          title={shareCopied ? 'Link copied' : 'Copy share link'}
        >
          <svg
            className="info-share-icon"
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <path d="M8.6 10.5 15.4 6.5" />
            <path d="M8.6 13.5 15.4 17.5" />
          </svg>
          <span>{shareCopied ? 'Copied' : 'Share'}</span>
        </button>
      )}
    </>
  )

  const startPanelDrag = (event: PointerEvent<HTMLElement>) => {
    if (!isMobilePanel()) return

    dragStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startCollapsed: collapsed,
      moved: false,
    }
    suppressClickRef.current = false
    setDragOffset(0)
    setIsDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const updatePanelDrag = (event: PointerEvent<HTMLElement>) => {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) return

    const deltaY = event.clientY - dragState.startY
    if (Math.abs(deltaY) > 4) {
      dragState.moved = true
      suppressClickRef.current = true
    }

    const nextOffset = dragState.startCollapsed ? Math.min(0, deltaY) : Math.max(0, deltaY)
    setDragOffset(nextOffset)
  }

  const finishPanelDrag = (event: PointerEvent<HTMLElement>) => {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) return

    const deltaY = event.clientY - dragState.startY
    if (dragState.startCollapsed && deltaY < -PANEL_DRAG_THRESHOLD) {
      setCollapsed(false)
    } else if (!dragState.startCollapsed && deltaY > PANEL_DRAG_THRESHOLD) {
      setCollapsed(true)
    }

    dragStateRef.current = null
    setDragOffset(0)
    setIsDragging(false)
  }

  const cancelPanelDrag = () => {
    dragStateRef.current = null
    setDragOffset(0)
    setIsDragging(false)
  }

  const selectMobileTab = (tab: InfoPanelTab, event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (suppressClickRef.current) {
      event.preventDefault()
      suppressClickRef.current = false
      return
    }
    setActiveTab(tab)
    if (collapsed) setCollapsed(false)
  }

  const toggleMobilePanel = (event: MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      event.preventDefault()
      suppressClickRef.current = false
      return
    }
    if (!isMobilePanel()) return
    setCollapsed((current) => !current)
  }

  const renderMobileTabSwitcher = (className: string) => (
    <div className={className} role="tablist" aria-label="Panel sections">
      {(['details', 'controls'] as const).map((tab) => {
        const label = tab === 'details' ? 'Area Details' : 'Map Controls'
        const active = activeTab === tab
        return (
          <button
            key={tab}
            type="button"
            className={`info-mobile-tab-button ${active ? 'active' : ''}`}
            role="tab"
            aria-selected={active}
            onClick={(event) => selectMobileTab(tab, event)}
          >
            <span className={`info-drawer-tab-symbol ${tab}`} aria-hidden="true" />
            <span>{label}</span>
          </button>
        )
      })}
    </div>
  )

  const renderDrawer = (detailsContent: ReactNode) => (
    <div
      className={`info-panel ${isDark ? 'dark' : 'light'} ${collapsed ? 'collapsed' : ''} ${
        isDragging ? 'dragging' : ''
      }`}
      style={{ '--panel-drag-offset': `${dragOffset}px` } as PanelStyle}
    >
      <div className="info-drawer-tabs" role="tablist" aria-label="Side panel sections">
        {(['details', 'controls'] as const).map((tab) => {
          const label = tab === 'details' ? 'Area Details' : 'Map Controls'
          const active = activeTab === tab
          const ariaLabel = active ? `${label} panel handle` : `Show ${label}`
          return (
            <button
              key={tab}
              type="button"
              className={`info-drawer-tab ${active ? 'active' : ''}`}
              role="tab"
              aria-label={ariaLabel}
              aria-selected={active}
              aria-expanded={active ? !collapsed : undefined}
              onClick={(event) => {
                if (suppressClickRef.current) {
                  event.preventDefault()
                  suppressClickRef.current = false
                  return
                }
                selectDrawerTab(tab)
              }}
            >
              <span className={`info-drawer-tab-symbol ${tab}`} aria-hidden="true" />
              <span className="info-drawer-tab-label">{label}</span>
              <span className="info-drawer-tab-grip" aria-hidden="true" />
            </button>
          )
        })}
      </div>
      <div
        className="info-mobile-panel-handle"
        title={collapsed ? 'Drag up to open panel' : 'Drag down to close panel'}
        onPointerDown={startPanelDrag}
        onPointerMove={updatePanelDrag}
        onPointerUp={finishPanelDrag}
        onPointerCancel={cancelPanelDrag}
        onClick={toggleMobilePanel}
      >
        <span className="info-mobile-panel-grip" aria-hidden="true" />
      </div>
      <div className="info-panel-shell">
        {renderMobileTabSwitcher('info-mobile-tab-switcher')}
        <div
          className="info-panel-content"
          role="tabpanel"
          aria-label="Area details"
          hidden={activeTab !== 'details'}
        >
          {detailsContent}
        </div>
        <div
          className="info-panel-content info-controls-content"
          role="tabpanel"
          aria-label="Map controls"
          hidden={activeTab !== 'controls'}
        >
          {controls}
        </div>
      </div>
    </div>
  )

  if (!data || !selectedYearAgeGroupData || typeof total !== 'number') {
    return renderDrawer(
      <div className="info-heading">
        <span className="info-kicker">{selectedYear} Census</span>
        {heading}
        <p className="info-subtitle">
          {detailLoading || !data
            ? 'Loading...'
            : !selectedYearAgeGroupData
              ? `No data for ${selectedYear}`
              : 'No ethnicity data for this area'}
        </p>
      </div>,
    )
  }

  const items = processUnifiedData(
    selectedYearAgeGroupData,
    total,
    baseYearAgeGroupData,
    baseTotal,
    selectedYear,
  )

  const yearAllAges = data.ethnicityData?.[selectedYear]
  const ageLabel = selectedAgeGroup === 'Total - age' ? 'All ages' : selectedAgeGroup

  return renderDrawer(
    <>
      <div className="info-heading">
        <span className="info-kicker">{selectedYear} Census</span>
        {heading}
        <span className="info-age-pill">{ageLabel}</span>
      </div>
      <p className="info-subtitle">Single/combination responses</p>

      <EthnicityPie items={items} isDark={isDark} />

      {selectedAgeGroup === 'Total - age' && (
        <AgeBreakdown yearData={yearAllAges} isDark={isDark} />
      )}

      {items.map((item) => (
        <div key={item.name}>
          <div
            className={`info-row depth-0 ${!item.isExpandable ? 'no-expand' : ''}`}
            onClick={() => item.isExpandable && toggleExpand(item.name)}
          >
            <span className="info-label">
              {item.isExpandable && (
                <span
                  className={`expand-icon ${expandedCategories.has(item.name) ? 'expanded' : ''}`}
                  aria-hidden="true"
                />
              )}
              <span>{item.name}</span>
            </span>
            <span className="info-value">{item.value.toLocaleString()}</span>
            <span className="info-pct">({item.percentage}%)</span>
            <span className={`info-change ${item.changeColorClass}`} title={item.changeTooltip}>
              {item.changeIcon}
            </span>
          </div>
          {item.isExpandable &&
            expandedCategories.has(item.name) &&
            (item.children ?? [])
              .map((childName) => ({
                name: childName,
                data: level3SelectedYearData?.[LEVEL3_KEY_MAP[childName] || childName] || 0,
              }))
              .sort((a, b) => b.data - a.data)
              .map((child) => {
                const childPct = total > 0 ? ((child.data / total) * 100).toFixed(1) : '0.0'
                return (
                  <div key={`${item.name}-child-${child.name}`} className="info-row depth-1">
                    <span className="info-label child">
                      <span className="expand-icon-placeholder" />
                      <span>{child.name}</span>
                    </span>
                    <span className="info-value">{child.data.toLocaleString()}</span>
                    <span className="info-pct">({childPct}%)</span>
                  </div>
                )
              })}
        </div>
      ))}

      <div className="info-total">
        <span>Total stated:</span>
        <span>{total.toLocaleString()}</span>
      </div>
    </>,
  )
}

export default InfoPanel
