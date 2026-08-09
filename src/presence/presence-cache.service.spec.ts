import { Test, TestingModule } from '@nestjs/testing';

import { redisConfig } from '@config/redis.config';

import { REDIS_CLIENT } from '@app/redis/redis.constants';

import { PresenceCacheService } from './presence-cache.service';

describe('PresenceCacheService', () => {
  let service: PresenceCacheService;
  const redis = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PresenceCacheService,
        { provide: REDIS_CLIENT, useValue: redis },
        {
          provide: redisConfig.KEY,
          useValue: { host: 'x', port: 1, password: '', presenceTtlS: 300 },
        },
      ],
    }).compile();

    service = module.get(PresenceCacheService);
  });

  describe('get — distinguishes hit, miss, and error', () => {
    it('returns a hit with parsed area ids', async () => {
      redis.get.mockResolvedValue('["a","b"]');
      await expect(service.get('u1')).resolves.toEqual({ status: 'hit', areaIds: ['a', 'b'] });
      expect(redis.get).toHaveBeenCalledWith('presence:u1');
    });

    it('returns a hit for the cached empty set "[]" — known to be in no areas', async () => {
      redis.get.mockResolvedValue('[]');
      await expect(service.get('u1')).resolves.toEqual({ status: 'hit', areaIds: [] });
    });

    it('returns miss for an absent key — the only case that may write back', async () => {
      redis.get.mockResolvedValue(null);
      await expect(service.get('u1')).resolves.toEqual({ status: 'miss' });
    });

    it('returns error when redis fails — falls through to DB without write-back', async () => {
      redis.get.mockRejectedValue(new Error('timeout'));
      await expect(service.get('u1')).resolves.toEqual({ status: 'error' });
    });
  });

  it('populate stores a JSON array string WITH the TTL — the staleness bound (ADR 0013)', async () => {
    redis.set.mockResolvedValue('OK');
    await service.populate('u1', []);
    expect(redis.set).toHaveBeenCalledWith('presence:u1', '[]', 'EX', 300);
    await service.populate('u1', ['a']);
    expect(redis.set).toHaveBeenCalledWith('presence:u1', '["a"]', 'EX', 300);
  });

  it('populate and invalidate swallow redis failures', async () => {
    redis.set.mockRejectedValue(new Error('down'));
    redis.del.mockRejectedValue(new Error('down'));
    await expect(service.populate('u1', ['a'])).resolves.toBeUndefined();
    await expect(service.invalidate('u1')).resolves.toBeUndefined();
  });

  it('invalidate deletes the key', async () => {
    redis.del.mockResolvedValue(1);
    await service.invalidate('u1');
    expect(redis.del).toHaveBeenCalledWith('presence:u1');
  });
});
