import { useId, useMemo, useState } from 'react';
import { fuzzyFilter } from '../fuzzy';
import type { Module } from '../types';

interface Props {
  modules: Module[]; value: number | null; onChange: (id: number | null) => void;
  label?: string; required?: boolean; autoFocus?: boolean;
  placeholder?: string; // overrides the default hint; also used by add-style pickers that are never "invalid"
}

// Type-to-search module chooser (fuzzy: "plbb" finds "Platform black box"). Arrow keys + Enter, Esc closes.
export function ModulePicker({ modules, value, onChange, label = 'Module', required = false, autoFocus, placeholder }: Props) {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selected = modules.find((m) => m.id === value);
  const matches = useMemo(() => fuzzyFilter(modules, query, (m) => m.name), [modules, query]);
  const choose = (m: Module) => { onChange(m.id); setQuery(''); setOpen(false); };
  const close = () => { setOpen(false); setQuery(''); };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, matches.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter' && open) { e.preventDefault(); if (matches[active]) choose(matches[active]); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); close(); }
  };

  return (
    <div className="module-picker">
      <input
        role="combobox" aria-label={label} aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-required={required}
        aria-invalid={required && !placeholder && value == null ? true : undefined} autoFocus={autoFocus} autoComplete="off"
        placeholder={placeholder ?? (required ? 'Search modules…' : 'Search modules (optional)…')}
        value={open ? query : selected ? `${selected.icon ?? ''} ${selected.name}`.trim() : ''}
        onFocus={() => { setOpen(true); setActive(0); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
        onBlur={close} onKeyDown={onKey}
      />
      {!required && selected && <button type="button" className="mp-clear" aria-label={`Clear ${label.toLowerCase()}`} onMouseDown={(e) => { e.preventDefault(); onChange(null); }}>×</button>}
      {open && (
        <ul id={listId} role="listbox" aria-label={`${label} matches`} className="mp-list">
          {matches.length === 0 && <li className="mp-empty">{modules.length === 0 ? 'No modules yet. Create one in the diagram first.' : 'No module matches'}</li>}
          {matches.map((m, i) => (
            <li key={m.id} role="option" aria-selected={m.id === value} className={`mp-opt${i === active ? ' active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); choose(m); }} onMouseEnter={() => setActive(i)}>
              <span className="mp-dot" style={{ background: m.color ?? 'var(--border)' }} />{m.icon} {m.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
