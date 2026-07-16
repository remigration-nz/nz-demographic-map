export type Theme = 'light' | 'dark'

export type GeographyTier = 'rc' | 'ta' | 'sa2'

export type AgeGroup =
  | 'Total - age'
  | 'Under 15 years'
  | '15-29 years'
  | '30-64 years'
  | '65 years and over'

export interface EthnicityCounts {
  [ethnicity: string]: number
}

export interface RegionEntry {
  ethnicityData: {
    [year: string]: {
      [ageGroup: string]: EthnicityCounts
    }
  }
}

export type RegionData = Record<string, RegionEntry>

export interface UnifiedData {
  detailedSingle: RegionData
  level3: RegionData
}

export interface DisplayItem {
  name: string
  value: number
  percentage: string
  changeIcon: string
  changeColorClass: string
  changeTooltip: string
  isExpandable: boolean
  children?: string[]
  breakdown?: DisplayChild[]
}

export interface DisplayChild {
  name: string
  value: number
}

export interface EuropeanMetric {
  count: number
  percentage: number
}

export const AGE_GROUPS: AgeGroup[] = [
  'Total - age',
  'Under 15 years',
  '15-29 years',
  '30-64 years',
  '65 years and over',
]

export const NATIONAL_KEY = 'Total - New Zealand by regional council'

export const TA_ZOOM_THRESHOLD = 7
export const SA2_ZOOM_THRESHOLD = 10

export const CATEGORY_COLORS: Record<string, string> = {
  European: '#3b82f6',
  'European/Maori': '#8b5cf6',
  Maori: '#ef4444',
  'Pacific Islander': '#f59e0b',
  Asian: '#10b981',
  'MELAA & Other': '#6b7280',
  'Other Mixed': '#ec4899',
}

export const LEVEL3_KEY_MAP: Record<string, string> = {
  'New Zealander': 'New Zealand European',
  'British & Irish': 'British and Irish',
  Dutch: 'Dutch',
  Greek: 'Greek',
  Polish: 'Polish',
  'South Slav': 'South Slav',
  Italian: 'Italian',
  German: 'German',
  Australian: 'Australian',
  'Other European': 'Other European',
  Samoan: 'Samoan',
  'Cook Islands Maori': 'Cook Islands Maori',
  Tongan: 'Tongan',
  Niuean: 'Niuean',
  Tokelauan: 'Tokelauan',
  Fijian: 'Fijian',
  Other: 'Other Pacific Islanders',
  Chinese: 'Chinese',
  Indian: 'Indian',
  Filipino: 'Filipino',
  Japanese: 'Japanese',
  Korean: 'Korean',
  'Sri Lankan': 'Sri Lankan',
  Vietnamese: 'Vietnamese',
  'Other Asian': 'Other Asian',
  'Other South East Asian': 'Other Southeast Asian',
  Cambodian: 'Cambodian',
  'Middle Eastern': 'Middle Eastern',
  'Latin American': 'Latin American',
  African: 'African',
  'Other Ethnicity': 'Other Ethnicity',
}

export const TILE_SOURCES = {
  rc: { url: '/tiles/rc.pmtiles', layer: 'rc', nameProp: 'REGC2025_1' },
  ta: { url: '/tiles/ta.pmtiles', layer: 'ta', nameProp: 'TA2025_V_1' },
  sa2: { url: '/tiles/sa2.pmtiles', layer: 'sa2', nameProp: 'SA22025__2' },
} as const
