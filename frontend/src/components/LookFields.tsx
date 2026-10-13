import { ACCENT, type Theme } from '../theme';
import { addSavedColor, removeSavedColor, useSavedColors } from '../savedColors';

export const EMOJI = [
  '🔐', '💳', '📦', '🗄️', '🌐', '📧', '⚙️', '📊', '🔔', '🧪',
  '🔑', '🛡️', '🔒', '🧾', '💰', '🏦', '🛒', '🏷️', '📈', '📉',
  '👤', '👥', '🧑‍💻', '🪪', '💬', '📞', '📱', '💻', '🖥️', '⌨️',
  '☁️', '🗃️', '💾', '📁', '📂', '📄', '📝', '📚', '🔍', '🔗',
  '🔌', '🧩', '🧰', '🔧', '🛠️', '🧱', '🏗️', '🚀', '✈️', '🚚',
  '📡', '📶', '🛰️', '🎮', '🎲', '🎰', '🏆', '🎯', '🃏', '🎁',
  '🎨', '🖼️', '🎬', '🎵', '🔊', '📷', '📺', '🕹️', '⏱️', '📅',
  '🗺️', '📍', '🧭', '🏠', '🏢', '🏭', '⚡', '🔥', '💡', '🔋',
  '🌍', '🌱', '🌟', '⭐', '❤️', '✅', '❗', '❓', '🐞', '🦊',
  '🤖', '🧠', '🪄', '🧮', '📐', '🧬', '⚖️', '🔄', '♻️', '🗑️',
];

export function ColorField({ label = 'Colour', value, onChange, theme = 'dark' }: {
  label?: string; value: string | null; onChange: (c: string | null) => void; theme?: Theme;
}) {
  const saved = useSavedColors();
  const canSave = value !== null && !saved.includes(value.toLowerCase());
  return (
    <div className="color-field">
    <div className="row wrap">
      <label className="check">{label}
        <input type="color" aria-label={label} value={value ?? ACCENT[theme]} onChange={(e) => onChange(e.target.value)} />
      </label>
      <button type="button" onClick={() => onChange(null)} disabled={value === null}>Reset {label.toLowerCase()}</button>
      <button type="button" onClick={() => value && addSavedColor(value)} disabled={!canSave}>Save colour</button>
    </div>
    {saved.length > 0 && (
      <div className="row wrap saved-colors">
        {saved.map((c) => (
          <span key={c} className="saved-color">
            <button type="button" className="saved-swatch" style={{ background: c }} aria-label={`Use saved colour ${c}`} title={c} onClick={() => onChange(c)} />
            <button type="button" className="saved-remove" aria-label={`Remove saved colour ${c}`} onClick={() => removeSavedColor(c)}>×</button>
          </span>
        ))}
      </div>
    )}
    </div>
  );
}

export function IconField({ value, onChange }: { value: string | null; onChange: (i: string | null) => void }) {
  return (
    <>
      <div className="row wrap">
        <input className="icon-input" aria-label="Icon" placeholder="Icon" maxLength={8} value={value ?? ''}
          onChange={(e) => onChange(e.target.value || null)} />
        <button type="button" onClick={() => onChange(null)} disabled={!value}>Clear icon</button>
      </div>
      <div className="emoji-grid">
        {EMOJI.map((e) => (
          <button type="button" key={e} className="emoji" aria-label={`Pick ${e}`} onClick={() => onChange(e)}>{e}</button>
        ))}
      </div>
    </>
  );
}
