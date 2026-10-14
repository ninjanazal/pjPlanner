import { CARD_LABEL, POKER_CARDS } from '../estimate';

// Row of planning-poker cards. Click the chosen card again to clear it (an unset estimate counts as 1 step).
export function EstimatePicker({ value, onChange, label = 'Estimate' }: { value: number | null; onChange: (v: number | null) => void; label?: string }) {
  const custom = value != null && !(POKER_CARDS as readonly number[]).includes(value); // an older, off-scale value stays visible
  const cards = custom ? [...POKER_CARDS, value] : [...POKER_CARDS];
  return (
    <div className="poker" role="group" aria-label={label}>
      {cards.map((n) => (
        <button key={n} type="button" className={`poker-card${value === n ? ' on' : ''}`} aria-pressed={value === n}
          title={CARD_LABEL[n] ?? 'custom size'} onClick={() => onChange(value === n ? null : n)}>
          <b>{n}</b><span>{CARD_LABEL[n] ?? 'custom'}</span>
        </button>
      ))}
    </div>
  );
}
