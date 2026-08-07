import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateAreaDto } from './create-area.dto';

const squareRing = [
  [0, 0],
  [0, 1],
  [1, 1],
  [1, 0],
  [0, 0],
];

const dtoWithBoundary = (coordinates: unknown): CreateAreaDto =>
  plainToInstance(CreateAreaDto, {
    name: 'test-area',
    boundary: { type: 'Polygon', coordinates },
  });

const boundaryFailures = async (dto: CreateAreaDto): Promise<string[]> => {
  const errors = await validate(dto);
  return errors
    .filter((error) => error.property === 'boundary')
    .flatMap((error) => Object.values(error.constraints ?? {}));
};

describe('CreateAreaDto boundary validation', () => {
  it('accepts a closed square polygon', async () => {
    expect(await boundaryFailures(dtoWithBoundary([squareRing]))).toEqual([]);
  });

  it('rejects an unclosed ring naming the closure rule', async () => {
    const failures = await boundaryFailures(
      dtoWithBoundary([
        [
          [0, 0],
          [0, 1],
          [1, 1],
          [1, 0],
        ],
      ]),
    );
    expect(failures.join(' ')).toContain('not closed');
  });

  it('rejects latitude out of range in the latitude slot', async () => {
    const failures = await boundaryFailures(
      dtoWithBoundary([
        [
          [0, 91],
          [0, 1],
          [1, 1],
          [0, 91],
        ],
      ]),
    );
    expect(failures.join(' ')).toContain('latitude 91 out of range [-90, 90]');
  });

  it('rejects longitude out of range', async () => {
    const failures = await boundaryFailures(
      dtoWithBoundary([
        [
          [181, 0],
          [0, 1],
          [1, 1],
          [181, 0],
        ],
      ]),
    );
    expect(failures.join(' ')).toContain('longitude 181 out of range [-180, 180]');
  });

  it('rejects 1001 distinct vertices and accepts 1000', async () => {
    const ringOf = (distinctVertices: number): number[][] => {
      const ring: number[][] = [];
      for (let i = 0; i < distinctVertices; i += 1) {
        const angle = (2 * Math.PI * i) / distinctVertices;
        ring.push([Math.cos(angle), Math.sin(angle)]);
      }
      ring.push([...ring[0]]);
      return ring;
    };

    expect((await boundaryFailures(dtoWithBoundary([ringOf(1001)]))).join(' ')).toContain(
      'maximum is 1000',
    );
    expect(await boundaryFailures(dtoWithBoundary([ringOf(1000)]))).toEqual([]);
  });

  it('rejects a position that is not a [lng, lat] pair', async () => {
    const failures = await boundaryFailures(
      dtoWithBoundary([
        [
          [0, 0, 5],
          [0, 1],
          [1, 1],
          [0, 0, 5],
        ],
      ]),
    );
    expect(failures.join(' ')).toContain('[lng, lat] pair');
  });

  it('passes a self-intersecting bowtie: geometric validity is deliberately PostGIS-side', async () => {
    const bowtie = [
      [0, 0],
      [10, 10],
      [10, 0],
      [0, 10],
      [0, 0],
    ];
    expect(await boundaryFailures(dtoWithBoundary([bowtie]))).toEqual([]);
  });
});
