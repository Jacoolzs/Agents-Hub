import { AppError } from "@agents-hub/shared";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface RateLimitRule {
  windowMs: number;
  max: number;
}

export interface RateLimiterOptions {
  ipRule?: RateLimitRule;
  identityRule?: RateLimitRule;
}

interface WindowBucket {
  timestamps: number[];
}

export class RateLimiter {
  private ipBuckets = new Map<string, WindowBucket>();
  private identityBuckets = new Map<string, WindowBucket>();
  private ipRule: RateLimitRule;
  private identityRule: RateLimitRule;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(options?: RateLimiterOptions) {
    this.ipRule = options?.ipRule ?? { windowMs: 60_000, max: 200 };
    this.identityRule = options?.identityRule ?? { windowMs: 60_000, max: 150 };

    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60_000);
    this.cleanupInterval.unref?.();
  }

  public check(req: FastifyRequest, reply: FastifyReply, authIdentity?: string): void {
    const now = Date.now();
    const ip = req.ip || "127.0.0.1";

    // 1. Check IP rule
    const ipResult = this.checkBucket(this.ipBuckets, ip, this.ipRule, now);

    // 2. Check Identity rule (if authenticated)
    let identityResult: {
      allowed: boolean;
      remaining: number;
      limit: number;
      resetSeconds: number;
    } | null = null;

    if (authIdentity) {
      identityResult = this.checkBucket(this.identityBuckets, authIdentity, this.identityRule, now);
    }

    // Determine the most restrictive result
    const effective =
      identityResult && !identityResult.allowed
        ? identityResult
        : !ipResult.allowed
          ? ipResult
          : identityResult && identityResult.remaining < ipResult.remaining
            ? identityResult
            : ipResult;

    // Apply standard RateLimit headers (RFC 6585 & IETF draft)
    reply.header("RateLimit-Limit", effective.limit);
    reply.header("RateLimit-Remaining", Math.max(0, effective.remaining));
    reply.header("RateLimit-Reset", effective.resetSeconds);

    if (!effective.allowed) {
      reply.header("Retry-After", effective.resetSeconds);
      throw new AppError(
        "RATE_LIMITED",
        `Rate limit exceeded. Try again in ${effective.resetSeconds} seconds.`,
      );
    }
  }

  private checkBucket(
    store: Map<string, WindowBucket>,
    key: string,
    rule: RateLimitRule,
    now: number,
  ): { allowed: boolean; remaining: number; limit: number; resetSeconds: number } {
    let bucket = store.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      store.set(key, bucket);
    }

    const windowStart = now - rule.windowMs;
    bucket.timestamps = bucket.timestamps.filter((t) => t > windowStart);

    const oldest = bucket.timestamps[0];
    const resetMs = oldest ? oldest + rule.windowMs - now : rule.windowMs;
    const resetSeconds = Math.max(1, Math.ceil(resetMs / 1000));

    if (bucket.timestamps.length >= rule.max) {
      return {
        allowed: false,
        remaining: 0,
        limit: rule.max,
        resetSeconds,
      };
    }

    bucket.timestamps.push(now);
    return {
      allowed: true,
      remaining: rule.max - bucket.timestamps.length,
      limit: rule.max,
      resetSeconds,
    };
  }

  private cleanup(): void {
    const now = Date.now();
    const cleanStore = (store: Map<string, WindowBucket>, windowMs: number) => {
      const windowStart = now - windowMs;
      for (const [key, bucket] of store.entries()) {
        bucket.timestamps = bucket.timestamps.filter((t) => t > windowStart);
        if (bucket.timestamps.length === 0) {
          store.delete(key);
        }
      }
    };
    cleanStore(this.ipBuckets, this.ipRule.windowMs);
    cleanStore(this.identityBuckets, this.identityRule.windowMs);
  }

  public reset(): void {
    this.ipBuckets.clear();
    this.identityBuckets.clear();
  }

  public destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.reset();
  }
}
