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
          useValue: {
            host: 'x',
            port: 1,
            password: '',
            presenceTtlEmptyS: 300,
            presenceTtlNonEmptyS: 15,
          },
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

  it('populate puts the SHORT clock on non-empty values and the long one on "[]" (the fatal direction gets the short TTL)', async () => {
    redis.set.mockResolvedValue('OK');
    await service.populate('u1', []);
    expect(redis.set).toHaveBeenCalledWith('presence:u1', '[]', 'EX', 300);
    await service.populate('u1', ['a']);
    expect(redis.set).toHaveBeenCalledWith('presence:u1', '["a"]', 'EX', 15);
  });

  it('populate and invalidate swallow redis failures; invalidate reports the failure', async () => {
    redis.set.mockRejectedValue(new Error('down'));
    redis.del.mockRejectedValue(new Error('down'));
    await expect(service.populate('u1', ['a'])).resolves.toBeUndefined();
    await expect(service.invalidate('u1')).resolves.toBe(false);
  });

  it('invalidate deletes the key and reports success', async () => {
    redis.del.mockResolvedValue(1);
    await expect(service.invalidate('u1')).resolves.toBe(true);
    expect(redis.del).toHaveBeenCalledWith('presence:u1');
  });
});
