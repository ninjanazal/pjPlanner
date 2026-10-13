import { EMOJI } from './components/LookFields';

export const randomIcon = (rng: () => number = Math.random): string => EMOJI[Math.floor(rng() * EMOJI.length)];
