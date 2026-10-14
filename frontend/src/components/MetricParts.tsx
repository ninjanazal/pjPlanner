import type { ReactNode } from 'react';

// Small building blocks shared by the owner and project metric views.
export function Kpi({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'warn' | 'good' }) {
  return (
    <div className={`kpi${tone ? ` kpi-${tone}` : ''}`}>
      <span className="kpi-label">{label}</span>
      <b className="kpi-value">{value}</b>
      {hint != null && <span className="hint">{hint}</span>}
    </div>
  );
}

// Horizontal bar: `pct` (0-100) is the filled part.
export function Bar({ pct, label, tone }: { pct: number; label: string; tone?: 'warn' }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div className={`bar${tone ? ` bar-${tone}` : ''}`} role="progressbar" aria-label={label} aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${p}%` }} />
    </div>
  );
}

// Circular progress: `pct` (0-100) of the ring is filled; children render in the middle.
export function Ring({ pct, size = 150, stroke = 14, label, children }: { pct: number; size?: number; stroke?: number; label: string; children?: ReactNode }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, pct));
  return (
    <div className="ring" style={{ width: size, height: size }} role="progressbar" aria-label={label} aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--btn)" strokeWidth={stroke} />
        <circle className="ring-fill" cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--primary-border)" strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - p / 100)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}

export interface Slice { label: string; value: number; color: string }

// Donut chart with a legend; `center` shows in the hole.
export function Donut({ slices, center, label, size = 150, stroke = 22 }: { slices: Slice[]; center?: ReactNode; label: string; size?: number; stroke?: number }) {
  const total = slices.reduce((n, s) => n + s.value, 0);
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="donut-wrap">
      <div className="ring" style={{ width: size, height: size }} role="img" aria-label={`${label}: ${slices.map((s) => `${s.value} ${s.label}`).join(', ')}`}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--btn)" strokeWidth={stroke} />
          {total > 0 && slices.filter((s) => s.value > 0).map((s) => {
            const len = (s.value / total) * c;
            const el = <circle key={s.label} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={stroke}
              strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset} transform={`rotate(-90 ${size / 2} ${size / 2})`} />;
            offset += len;
            return el;
          })}
        </svg>
        <div className="ring-center">{center}</div>
      </div>
      <ul className="legend">
        {slices.map((s) => <li key={s.label}><span className="legend-dot" style={{ background: s.color }} />{s.label} <b>{s.value}</b></li>)}
      </ul>
    </div>
  );
}

export interface PairPoint { label: string; a: number; b: number }

// Grouped vertical bars (two series per point), e.g. tasks created vs closed per week.
export function PairBars({ data, aLabel, bLabel, label }: { data: PairPoint[]; aLabel: string; bLabel: string; label: string }) {
  const max = Math.max(1, ...data.flatMap((d) => [d.a, d.b]));
  const W = 560, H = 170, pad = 22, slot = (W - pad) / Math.max(1, data.length), bw = Math.min(22, slot / 2 - 4);
  const y = (v: number) => H - pad - (v / max) * (H - pad - 14);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="pair-bars" role="img" aria-label={`${label}: ${data.map((d) => `${d.label} ${d.a} ${aLabel}, ${d.b} ${bLabel}`).join('; ')}`}>
        <line x1={pad} x2={W} y1={H - pad} y2={H - pad} stroke="var(--border)" />
        {data.map((d, i) => {
          const cx = pad + slot * i + slot / 2;
          return (
            <g key={i}>
              <rect x={cx - bw - 1} y={y(d.a)} width={bw} height={H - pad - y(d.a)} rx="3" fill="var(--accent)" />
              <rect x={cx + 1} y={y(d.b)} width={bw} height={H - pad - y(d.b)} rx="3" fill="var(--primary-border)" />
              {d.a > 0 && <text x={cx - bw / 2 - 1} y={y(d.a) - 3} textAnchor="middle" fontSize="11" fill="var(--muted)">{d.a}</text>}
              {d.b > 0 && <text x={cx + bw / 2 + 1} y={y(d.b) - 3} textAnchor="middle" fontSize="11" fill="var(--muted)">{d.b}</text>}
              <text x={cx} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--muted)">{d.label}</text>
            </g>
          );
        })}
      </svg>
      <ul className="legend legend-row">
        <li><span className="legend-dot" style={{ background: 'var(--accent)' }} />{aLabel}</li>
        <li><span className="legend-dot" style={{ background: 'var(--primary-border)' }} />{bLabel}</li>
      </ul>
    </div>
  );
}
