/**
 * Token-bucket rate limiter. Each bucket holds up to `capacity` tokens and
 * refills continuously at `refillPerSecond`. A call consumes one token.
 */
export interface RateLimitConfig {
  capacity: number;
  refillPerSecond: number;
}

export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly cfg: RateLimitConfig;
  private readonly now: () => number;

  constructor(cfg: RateLimitConfig, now: () => number = () => performance.now()) {
    this.cfg = cfg;
    this.now = now;
    if (!(cfg.capacity >= 1) || !(cfg.refillPerSecond > 0)) {
      throw new RangeError('capacity must be >= 1 and refillPerSecond > 0');
    }
    this.tokens = cfg.capacity;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    const elapsedSec = Math.max(0, t - this.last) / 1000;
    this.last = t;
    this.tokens = Math.min(this.cfg.capacity, this.tokens + elapsedSec * this.cfg.refillPerSecond);
  }

  /** Try to take one token. Returns 0 on success, otherwise ms until a token is available. */
  tryTake(): number {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - this.tokens) / this.cfg.refillPerSecond) * 1000);
  }

  available(): number {
    this.refill();
    return this.tokens;
  }
}

/** One independent bucket per tool name. */
export class ToolRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly cfg: RateLimitConfig;
  private readonly now: (() => number) | undefined;

  constructor(cfg: RateLimitConfig, now?: () => number) {
    this.cfg = cfg;
    this.now = now;
  }

  tryTake(tool: string): number {
    let bucket = this.buckets.get(tool);
    if (!bucket) {
      bucket = new TokenBucket(this.cfg, this.now);
      this.buckets.set(tool, bucket);
    }
    return bucket.tryTake();
  }
}
