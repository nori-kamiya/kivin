// Compile-time tests: Bun's Redis client fits the structural client type the Redis stores and the job lock take.
import { createRedisJobLock, type JobLock, type RedisCommandClient as ScheduleRedisClient } from '@kivinjs/schedule';
import { RedisRateLimitStore, type RateLimitStore, type RedisCommandClient as SecurityRedisClient } from '@kivinjs/security';
import { RedisSessionStore, type RedisCommandClient as SessionRedisClient, type SessionStore } from '@kivinjs/session';
import type { RedisClient } from 'bun';

declare const client: RedisClient;

export const clients: [SessionRedisClient, SecurityRedisClient, ScheduleRedisClient] = [client, client, Bun.redis];
export const sessionStore: SessionStore = new RedisSessionStore(client, { prefix: 'app:sess:' });
export const rateLimitStore: RateLimitStore = new RedisRateLimitStore(Bun.redis);
export const jobLock: JobLock = createRedisJobLock(client);

// @ts-expect-error a client without `send(command, args)` is rejected
export const withoutSend = new RedisSessionStore({ get: async (_key: string) => null });
// @ts-expect-error `send` must accept the arguments as a string array
export const narrowSend = createRedisJobLock({ send: async (_command: string, _args: number[]) => 'OK' });
