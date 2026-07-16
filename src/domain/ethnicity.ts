import { getValue } from './geo'
import type { DisplayChild, DisplayItem, EthnicityCounts } from './types'

interface CategoryDef {
  name: string
  key: string | null
  isMelaa?: boolean
  isOtherMixed?: boolean
  children: string[]
}

const OTHER_MIXED_BREAKDOWN = [
  { name: 'European/Pacific Islander', key: 'European/Pacific Peoples' },
  { name: 'Maori/Pacific Islander', key: 'Māori/Pacific Peoples' },
  { name: 'European/Asian', key: 'European/Asian' },
  { name: 'European/Maori/Pacific Islander', key: 'European/Māori/Pacific Peoples' },
] as const

const CATEGORIES: CategoryDef[] = [
  {
    name: 'European',
    key: 'European only',
    children: [
      'New Zealander',
      'British & Irish',
      'Dutch',
      'Greek',
      'Polish',
      'South Slav',
      'Italian',
      'German',
      'Australian',
      'Other European',
    ],
  },
  { name: 'European/Maori', key: 'European/Māori', children: [] },
  { name: 'Maori', key: 'Māori only', children: [] },
  {
    name: 'Pacific Islander',
    key: 'Pacific Peoples only',
    children: ['Samoan', 'Cook Islands Maori', 'Tongan', 'Niuean', 'Tokelauan', 'Fijian', 'Other'],
  },
  {
    name: 'Asian',
    key: 'Asian only',
    children: [
      'Chinese',
      'Indian',
      'Filipino',
      'Japanese',
      'Korean',
      'Sri Lankan',
      'Vietnamese',
      'Other Asian',
      'Other South East Asian',
      'Cambodian',
    ],
  },
  {
    name: 'MELAA & Other',
    key: null,
    isMelaa: true,
    children: ['Middle Eastern', 'Latin American', 'African', 'Other Ethnicity'],
  },
  {
    name: 'Other Mixed',
    key: null,
    isOtherMixed: true,
    children: OTHER_MIXED_BREAKDOWN.map((child) => child.name),
  },
]

function otherMixedValue(data: EthnicityCounts): number {
  return Object.entries(data).reduce((sum, [name, value]) => {
    const isMixedResponse =
      name.includes('/') && name !== 'European/Māori' && !name.endsWith(' only')
    return isMixedResponse && typeof value === 'number' && Number.isFinite(value)
      ? sum + value
      : sum
  }, 0)
}

function otherMixedBreakdown(data: EthnicityCounts): DisplayChild[] {
  const featured = OTHER_MIXED_BREAKDOWN.map(({ name, key }) => ({
    name,
    value: getValue(data, key),
  }))
  const remaining = otherMixedValue(data) - featured.reduce((sum, child) => sum + child.value, 0)
  return [...featured, { name: 'Other Combinations', value: Math.max(0, remaining) }]
}

function categoryValue(data: EthnicityCounts, cat: CategoryDef): number {
  if (cat.isMelaa) {
    return (
      getValue(data, 'Middle Eastern/Latin American/African only') +
      getValue(data, 'Other Ethnicity only')
    )
  }
  if (cat.isOtherMixed) {
    return otherMixedValue(data)
  }
  if (cat.key) return getValue(data, cat.key)
  return 0
}

function calculateChange(
  currentValue: number,
  currentTotal: number,
  baseValue: number,
  baseTotal: number | undefined,
  selectedYear: string,
): { icon: string; colorClass: string; tooltip: string } {
  let changeIcon = '–'
  let changeColorClass = 'change-neutral'
  let changeTooltip = '2013 data N/A'

  if (selectedYear !== '2013' && baseTotal && baseTotal > 0 && currentTotal > 0) {
    const currentPctNum = (currentValue / currentTotal) * 100
    const oldPctNum = (baseValue / baseTotal) * 100
    const ppDiff = currentPctNum - oldPctNum

    if (ppDiff > 0.05) {
      changeIcon = '▲'
      changeColorClass = 'change-green'
      changeTooltip = `+${ppDiff.toFixed(1)}% vs 2013`
    } else if (ppDiff < -0.05) {
      changeIcon = '▼'
      changeColorClass = 'change-red'
      changeTooltip = `${ppDiff.toFixed(1)}% vs 2013`
    }
  }

  return { icon: changeIcon, colorClass: changeColorClass, tooltip: changeTooltip }
}

export function processUnifiedData(
  detailedSingleData: EthnicityCounts,
  total: number,
  baseDetailedSingleData: EthnicityCounts | undefined,
  baseTotal: number | undefined,
  selectedYear: string,
): DisplayItem[] {
  const ranked = [...CATEGORIES].sort(
    (a, b) => categoryValue(detailedSingleData, b) - categoryValue(detailedSingleData, a),
  )

  return ranked.map((category) => {
    const mainValue = categoryValue(detailedSingleData, category)
    const pct = total > 0 ? ((mainValue / total) * 100).toFixed(1) : '0.0'
    const baseValue = baseDetailedSingleData ? categoryValue(baseDetailedSingleData, category) : 0
    const change = calculateChange(mainValue, total, baseValue, baseTotal, selectedYear)
    const hasChildren = category.children.length > 0

    return {
      name: category.name,
      value: mainValue,
      percentage: pct,
      changeIcon: change.icon,
      changeColorClass: change.colorClass,
      changeTooltip: change.tooltip,
      isExpandable: hasChildren,
      children: hasChildren ? category.children : undefined,
      breakdown: category.isOtherMixed ? otherMixedBreakdown(detailedSingleData) : undefined,
    }
  })
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

export function describeArc(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
) {
  const start = polarToCartesian(cx, cy, r, endAngle)
  const end = polarToCartesian(cx, cy, r, startAngle)
  const largeArc = endAngle - startAngle > 180 ? 1 : 0
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y} Z`
}
