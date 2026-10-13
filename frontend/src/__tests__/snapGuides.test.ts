import { snapGuides } from '../snapGuides';

const other = { x: 100, y: 200, w: 200, h: 100 };
const at = (x: number, y: number) => ({ x, y, w: 100, h: 50 });

describe('snapGuides', () => {
  it('snaps left edge within the threshold and reports a vertical guide', () => {
    const r = snapGuides(at(104, 500), [other], 6);
    expect(r.x).toBe(100);
    expect(r.y).toBe(500);
    expect(r.guides).toContainEqual({ axis: 'v', pos: 100, from: 200, to: 550 });
  });
  it('does not snap beyond the threshold', () => {
    const r = snapGuides(at(107, 500), [other], 6);
    expect(r).toEqual({ x: 107, y: 500, guides: [] });
  });
  it('snaps centre to centre and right to right', () => {
    expect(snapGuides(at(152, 500), [other], 6).x).toBe(150);
    expect(snapGuides(at(197, 500), [other], 6).x).toBe(200);
  });
  it('snaps top, middle and bottom on the y axis independently', () => {
    expect(snapGuides(at(0, 203), [other], 6).y).toBe(200);
    expect(snapGuides(at(0, 224), [other], 6).y).toBe(225);
    expect(snapGuides(at(0, 247), [other], 6).guides).toContainEqual(expect.objectContaining({ axis: 'h', pos: 300 }));
  });
  it('snaps both axes at once and prefers the closest line', () => {
    const r = snapGuides(at(103, 198), [other, { x: 102, y: 0, w: 10, h: 10 }], 6);
    expect(r.x).toBe(102);
    expect(r.y).toBe(200);
    expect(new Set(r.guides.map((g) => g.axis))).toEqual(new Set(['h', 'v']));
  });
  it('scales the threshold for zoom (threshold / zoom)', () => {
    expect(snapGuides(at(110, 500), [other], 6 / 0.5).x).toBe(100);
    expect(snapGuides(at(110, 500), [other], 6 / 2).x).toBe(110);
  });
  it('returns the input untouched with no other rects', () => {
    expect(snapGuides(at(3, 4), [])).toEqual({ x: 3, y: 4, guides: [] });
  });
});
