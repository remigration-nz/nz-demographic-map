import { europeanFillColor } from './domain/geo'

const GRADIENT_SAMPLES = 50
const LABELS = [0, 25, 50, 75, 100]

const gradientStops = Array.from({ length: GRADIENT_SAMPLES + 1 }, (_, i) => {
  const pct = (i / GRADIENT_SAMPLES) * 100
  return `${europeanFillColor(pct)} ${pct}%`
}).join(', ')

const gradient = `linear-gradient(to right, ${gradientStops})`

function MapLegend() {
  return (
    <div className="map-legend">
      <div className="map-legend-title">European ethnicity share (%)</div>
      <div className="map-legend-scale">
        <div className="map-legend-bar" style={{ background: gradient }} />
      </div>
      <div className="map-legend-labels">
        {LABELS.map((pct) => (
          <span key={pct} className="map-legend-label" style={{ left: `${pct}%` }}>
            {pct}
          </span>
        ))}
      </div>
      <div className="map-legend-row">
        <span className="map-legend-swatch" style={{ background: '#888' }} />
        <span className="map-legend-note">No data or sample &lt;50</span>
      </div>
    </div>
  )
}

export default MapLegend
