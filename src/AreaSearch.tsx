import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { normalizeName } from './domain/geo'
import { type GeographyTier, SA2_ZOOM_THRESHOLD, TA_ZOOM_THRESHOLD } from './domain/types'
import { assetUrl } from './lib/paths'

export interface SearchHit {
  name: string
  slug: string
  tier: GeographyTier
  center: [number, number] | null
}

interface SearchIndexRow {
  n: string
  s: string
  t: GeographyTier
  c: [number, number] | null
}

const TIER_LABEL: Record<string, string> = {
  rc: 'Region',
  ta: 'District/City',
  sa2: 'Area',
}

const TIER_ZOOM: Record<GeographyTier, number> = {
  rc: Math.max(5, TA_ZOOM_THRESHOLD - 1),
  ta: (TA_ZOOM_THRESHOLD + SA2_ZOOM_THRESHOLD) / 2,
  sa2: SA2_ZOOM_THRESHOLD + 2,
}

interface AreaSearchProps {
  onSelect: (hit: SearchHit, zoom: number) => void
  disabled?: boolean
}

function scoreMatch(name: string, query: string): number {
  const n = normalizeName(name)
  const q = normalizeName(query)
  if (!q) return 0
  if (n === q) return 100
  if (n.startsWith(q)) return 80
  if (n.includes(` ${q}`) || n.includes(`-${q}`)) return 60
  if (n.includes(q)) return 40
  // token match
  const tokens = q.split(/\s+/).filter(Boolean)
  if (tokens.length > 1 && tokens.every((t) => n.includes(t))) return 50
  return 0
}

function AreaSearch({ onSelect, disabled = false }: AreaSearchProps) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState<SearchIndexRow[] | null>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [loadError, setLoadError] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    fetch(assetUrl('data/prepared/search-index.json'))
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.json()
      })
      .then((data: SearchIndexRow[]) => {
        if (!cancelled) setIndex(data)
      })
      .catch(() => {
        if (!cancelled) setLoadError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const results = useMemo(() => {
    if (!index || query.trim().length < 2) return [] as SearchHit[]
    const scored: { hit: SearchHit; score: number }[] = []
    for (const row of index) {
      const score = scoreMatch(row.n, query)
      if (score <= 0) continue
      scored.push({
        score,
        hit: { name: row.n, slug: row.s, tier: row.t, center: row.c },
      })
    }
    scored.sort((a, b) => b.score - a.score || a.hit.name.localeCompare(b.hit.name))
    return scored.slice(0, 12).map((s) => s.hit)
  }, [index, query])

  const pick = useCallback(
    (hit: SearchHit) => {
      setQuery(hit.name)
      setOpen(false)
      onSelect(hit, TIER_ZOOM[hit.tier] ?? 10)
    },
    [onSelect],
  )

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter') && results.length > 0) {
      setOpen(true)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && results[active]) {
      e.preventDefault()
      pick(results[active])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="area-search" ref={wrapRef}>
      <a className="area-search-back" href="/" aria-label="Back to site home">
        <span className="area-search-back-icon" aria-hidden="true" />
        <span className="area-search-back-label">Back to site home</span>
      </a>
      <div className="area-search-main">
        <input
          ref={inputRef}
          type="search"
          className="area-search-input"
          placeholder="Search place or suburb…"
          value={query}
          disabled={disabled || loadError}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
            setActive(0)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          aria-label="Search places"
        />
        {open && query.trim().length >= 2 && (
          <div className="area-search-results">
            {results.length === 0 && (
              <div className="area-search-empty">{index ? 'No matching places' : 'Loading…'}</div>
            )}
            {results.map((hit, i) => (
              <button
                key={`${hit.tier}-${hit.slug}`}
                type="button"
                className={`area-search-item ${i === active ? 'active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(hit)}
              >
                <span className="area-search-name">{hit.name}</span>
                <span className="area-search-tier">{TIER_LABEL[hit.tier] || hit.tier}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default AreaSearch
