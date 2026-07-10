import { describe, expect, it } from 'vitest'
import {
  ageGroupSlug,
  buildNameIndex,
  europeanFillColor,
  findRegionData,
  getEuropeanData,
  normalizeName,
  tierForZoom,
} from '../domain/geo'
import type { RegionData } from '../domain/types'

const sample: RegionData = {
  'Auckland Region': {
    ethnicityData: {
      '2023': {
        'Total - age': {
          'European only': 50,
          'Total stated - ethnicity': 100,
        },
        'Under 15 years': {
          'European only': 20,
          'Total stated - ethnicity': 40,
        },
      },
    },
  },
  'Ōpōtiki District': {
    ethnicityData: {
      '2023': {
        'Total - age': {
          'European only': 30,
          'Total stated - ethnicity': 100,
        },
      },
    },
  },
}

describe('normalizeName', () => {
  it('strips macrons and lowercases', () => {
    expect(normalizeName('Ōpōtiki District')).toBe('opotiki district')
  })
})

describe('findRegionData', () => {
  it('finds exact keys', () => {
    expect(findRegionData(sample, 'Auckland Region')?.ethnicityData['2023']).toBeTruthy()
  })

  it('finds macron variants via index', () => {
    const index = buildNameIndex(sample)
    expect(findRegionData(sample, 'Opotiki District', index)).toBeTruthy()
  })
})

describe('getEuropeanData', () => {
  it('computes percentage', () => {
    const data = getEuropeanData(sample['Auckland Region'], '2023')
    expect(data?.percentage).toBe(50)
    expect(data?.count).toBe(50)
  })

  it('uses selected age group', () => {
    const data = getEuropeanData(sample['Auckland Region'], '2023', 'Under 15 years')
    expect(data?.percentage).toBe(50)
  })
})

describe('tierForZoom', () => {
  it('maps zoom thresholds', () => {
    expect(tierForZoom(5)).toBe('rc')
    expect(tierForZoom(6.99)).toBe('rc')
    expect(tierForZoom(7)).toBe('ta')
    expect(tierForZoom(9.99)).toBe('ta')
    expect(tierForZoom(10)).toBe('sa2')
  })
})

describe('ageGroupSlug', () => {
  it('slugs age groups for file paths', () => {
    expect(ageGroupSlug('Total - age')).toBe('all')
    expect(ageGroupSlug('Under 15 years')).toBe('under-15-years')
  })
})

describe('europeanFillColor', () => {
  it('returns a color string', () => {
    expect(europeanFillColor(80)).toMatch(/^rgb\(/)
    expect(europeanFillColor(undefined)).toBe('#888')
  })

  it('uses a non-grey midpoint at 50%', () => {
    expect(europeanFillColor(50)).toBe('rgb(246, 232, 170)')
    expect(europeanFillColor(50)).not.toBe('#888')
  })

  it('keeps brown below 50% and blue above 50%', () => {
    expect(europeanFillColor(25)).toBe('rgb(216, 179, 101)')
    expect(europeanFillColor(75)).toBe('rgb(116, 173, 209)')
  })
})
