import { randomIcon } from '../randomIcon';
import { EMOJI } from '../components/LookFields';

describe('randomIcon', () => {
  it('maps the rng range onto the EMOJI set', () => {
    expect(randomIcon(() => 0)).toBe(EMOJI[0]);
    expect(randomIcon(() => 0.999)).toBe(EMOJI[EMOJI.length - 1]);
  });
});
