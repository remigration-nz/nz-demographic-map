/** App base path (e.g. `/` or `/nz-demographic-map/`). Always ends with `/`. */
const BASE_URL = import.meta.env.BASE_URL || '/'
const PMTILES_BASE_URL = import.meta.env.VITE_PMTILES_BASE_URL || 'https://tiles.remigration.nz/'

/** Resolve a path under the app base for fetch / asset URLs. */
export function assetUrl(path: string): string {
  const clean = path.replace(/^\//, '')
  return `${BASE_URL}${clean}`
}

/** Absolute URL for PMTiles protocol (needs full origin + base). */
export function pmtilesUrl(path: string): string {
  const clean = path.replace(/^\//, '')
  if (/^https?:\/\//i.test(PMTILES_BASE_URL)) {
    return new URL(clean, PMTILES_BASE_URL).href
  }

  const localBase = PMTILES_BASE_URL.startsWith('/') ? PMTILES_BASE_URL : `/${PMTILES_BASE_URL}`
  if (typeof window === 'undefined') return `${localBase}${clean}`
  return new URL(`${localBase}${clean}`, window.location.origin).href
}
