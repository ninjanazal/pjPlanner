// The pjPlanner mark: three modules joined by links. Same artwork as public/favicon.svg.
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg className="logo" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <defs><linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#4f8cff" /><stop offset="1" stopColor="#7c4dff" /></linearGradient></defs>
      <rect width="64" height="64" rx="15" fill="url(#logo-g)" />
      <g fill="#fff"><rect x="9" y="12" width="20" height="14" rx="4" /><rect x="35" y="25" width="20" height="14" rx="4" /><rect x="9" y="42" width="20" height="14" rx="4" /></g>
      <g fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" opacity=".9"><path d="M29 19h6.5a3.5 3.5 0 0 1 3.5 3.5V25" /><path d="M29 49h6.5a3.5 3.5 0 0 0 3.5-3.5V39" /></g>
    </svg>
  );
}
