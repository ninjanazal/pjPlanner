// Planning-poker cards for a task's size in steps: 1 = super easy ... 10 = super hard. The server still accepts any
// whole number from 1 to 99 (older tasks may hold one), the UI just offers these cards.
export const POKER_CARDS = [1, 2, 3, 5, 8, 10] as const;
export const CARD_LABEL: Record<number, string> = { 1: 'super easy', 2: 'easy', 3: 'small', 5: 'medium', 8: 'hard', 10: 'super hard' };
