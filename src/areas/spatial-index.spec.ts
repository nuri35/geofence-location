import { Polygon } from 'geojson';

import { AreaSpatialIndex } from './spatial-index';

const square = (lngBase: number, latBase: number, size: number): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [lngBase, latBase],
      [lngBase + size, latBase],
      [lngBase + size, latBase + size],
      [lngBase, latBase + size],
      [lngBase, latBase],
    ],
  ],
});

/** 10×10 square at (0,0) with a 2×2 hole centered at (5,5). */
const squareWithHole: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
    [
      [4, 4],
      [6, 4],
      [6, 6],
      [4, 6],
      [4, 4],
    ],
  ],
};

/** Concave L: the 10×10 square minus its upper-right 5×5 quadrant. */
const concaveL: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [20, 0],
      [30, 0],
      [30, 5],
      [25, 5],
      [25, 10],
      [20, 10],
      [20, 0],
    ],
  ],
};

describe('AreaSpatialIndex', () => {
  it('returns the id of an area covering an interior point', () => {
    const index = new AreaSpatialIndex([{ id: 'a', boundary: square(0, 0, 10) }]);
    expect(index.findCoveringAreaIds(5, 5)).toEqual(['a']);
  });

  it('returns [] for a point outside every bounding box', () => {
    const index = new AreaSpatialIndex([{ id: 'a', boundary: square(0, 0, 10) }]);
    expect(index.findCoveringAreaIds(50, 50)).toEqual([]);
  });

  it('counts the boundary as inside — edge midpoint and vertex (ST_Covers semantics)', () => {
    const index = new AreaSpatialIndex([{ id: 'a', boundary: square(0, 0, 10) }]);
    expect(index.findCoveringAreaIds(5, 0)).toEqual(['a']); // edge midpoint
    expect(index.findCoveringAreaIds(0, 0)).toEqual(['a']); // vertex
    expect(index.findCoveringAreaIds(10, 10)).toEqual(['a']); // opposite vertex
  });

  it('excludes a point inside a hole', () => {
    const index = new AreaSpatialIndex([{ id: 'h', boundary: squareWithHole }]);
    expect(index.findCoveringAreaIds(5, 5)).toEqual([]);
  });

  it("counts a hole's ring as boundary, therefore inside", () => {
    const index = new AreaSpatialIndex([{ id: 'h', boundary: squareWithHole }]);
    expect(index.findCoveringAreaIds(5, 4)).toEqual(['h']); // hole edge midpoint
    expect(index.findCoveringAreaIds(4, 4)).toEqual(['h']); // hole vertex
  });

  it('returns every overlapping area covering the point', () => {
    const index = new AreaSpatialIndex([
      { id: 'a', boundary: square(0, 0, 10) },
      { id: 'b', boundary: square(5, 5, 10) },
    ]);
    expect(index.findCoveringAreaIds(7, 7).sort()).toEqual(['a', 'b']);
  });

  it('excludes a point inside the bbox but outside a concave polygon', () => {
    const index = new AreaSpatialIndex([{ id: 'L', boundary: concaveL }]);
    expect(index.findCoveringAreaIds(28, 8)).toEqual([]); // the notch
    expect(index.findCoveringAreaIds(22, 8)).toEqual(['L']); // the arm
  });

  it('exposes the number of indexed areas', () => {
    const index = new AreaSpatialIndex([
      { id: 'a', boundary: square(0, 0, 10) },
      { id: 'b', boundary: square(5, 5, 10) },
    ]);
    expect(index.areaCount).toBe(2);
  });

  it('handles an empty area set', () => {
    const index = new AreaSpatialIndex([]);
    expect(index.areaCount).toBe(0);
    expect(index.findCoveringAreaIds(0, 0)).toEqual([]);
  });
});
