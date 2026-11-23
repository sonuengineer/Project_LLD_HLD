// Retry budget, the token scheme gRPC uses for retry throttling.
//
// The problem: 3 attempts per call means a dependency that is DOWN gets 3x the traffic exactly when it is weakest
// (a "retry storm"). With several layers that each retry 3 times, 3 x 3 x 3 = 27x.
//
// The rule: a bucket starts full (maxTokens). Every failed attempt takes 1 token, every success puts back
// tokenRatio. Retries are only allowed while tokens > maxTokens / 2. So a few failures among many successes are
// retried as normal, but under a sustained outage the bucket drains and calls get ONE attempt each; once the
// dependency recovers, successes refill the bucket and retries come back by themselves.
//
// One budget per dependency, shared by every call to it. Counted in thousandths (integers), like gRPC, so adding
// 0.1 ten thousand times does not drift.
export interface RetryBudgetOptions {
  maxTokens?: number; // default 10
  tokenRatio?: number; // default 0.1, at most 3 decimals
}

const SCALE = 1000;

export class RetryBudget {
  private readonly max: number;
  private readonly ratio: number;
  private tokens: number;

  constructor(options: RetryBudgetOptions = {}) {
    const maxTokens = options.maxTokens ?? 10;
    const tokenRatio = options.tokenRatio ?? 0.1;
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) throw new RangeError("maxTokens must be > 0");
    if (!Number.isFinite(tokenRatio) || tokenRatio <= 0) throw new RangeError("tokenRatio must be > 0");
    this.max = Math.round(maxTokens * SCALE);
    this.ratio = Math.round(tokenRatio * SCALE);
    if (this.ratio === 0) throw new RangeError("tokenRatio must be at least 0.001");
    this.tokens = this.max;
  }

  get available(): number {
    return this.tokens / SCALE;
  }

  canRetry(): boolean {
    return this.tokens > this.max / 2;
  }

  onSuccess(): void {
    this.tokens = Math.min(this.max, this.tokens + this.ratio);
  }

  onFailure(): void {
    this.tokens = Math.max(0, this.tokens - SCALE);
  }
}
