// A random but readable colour: any hue, fixed saturation and lightness so it is never muddy, white or black. Returns #rrggbb.
export const randomColor = (rng: () => number = Math.random): string => {
  const h = rng() * 360, s = 0.65, l = 0.55;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
};
