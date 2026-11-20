import http from "node:http";
import type { Balancer, Target } from "./balancer.js";

/** Resolves true when the target answered the probe path with a 2xx or 3xx status, false on anything else. */
export type Probe = (base: URL, path: string, timeoutMs: number) => Promise<boolean>;

export interface HealthCheckOptions {
  /** the path to request on every upstream, for example "/health" */
  path: string;
  /** time between rounds of probes. Default 5000. */
  intervalMs?: number;
  /** a probe that takes longer counts as a failure. Default 2000. */
  timeoutMs?: number;
  /** consecutive failed probes before a healthy target is marked down. Default 2. */
  unhealthyThreshold?: number;
  /** consecutive passed probes before a down target is marked up again. Default 2. */
  healthyThreshold?: number;
  /** replace the real HTTP probe (tests). */
  probe?: Probe;
}

export const httpProbe: Probe = (base, path, timeoutMs) =>
  new Promise((resolve) => {
    const req = http.get(
      { hostname: base.hostname, port: base.port || 80, path, timeout: timeoutMs, agent: false, headers: { "user-agent": "reverse-proxy-healthcheck" } },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 500;
        resolve(status >= 200 && status < 400);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });

/**
 * ACTIVE health checking: ask every upstream "are you OK?" on a timer, independent of user traffic.
 * It needs several results in a row to flip a target, so one slow or lost probe does not cause flapping.
 */
export class HealthChecker {
  private readonly streaks = new Map<Target, { ok: number; bad: number }>();
  private timer: NodeJS.Timeout | undefined;
  private roundRunning = false;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly unhealthyThreshold: number;
  private readonly healthyThreshold: number;
  private readonly probe: Probe;

  constructor(
    private readonly balancer: Balancer,
    private readonly options: HealthCheckOptions,
  ) {
    this.intervalMs = options.intervalMs ?? 5000;
    this.timeoutMs = options.timeoutMs ?? 2000;
    this.unhealthyThreshold = options.unhealthyThreshold ?? 2;
    this.healthyThreshold = options.healthyThreshold ?? 2;
    this.probe = options.probe ?? httpProbe;
    if (!options.path.startsWith("/")) throw new Error(`health check path must start with / (got "${options.path}")`);
  }

  /** One round: probe every target at the same time and update the streaks. */
  async checkOnce(): Promise<void> {
    await Promise.all(
      this.balancer.targets.map(async (target) => {
        const ok = await this.probe(target.url, this.options.path, this.timeoutMs).catch(() => false);
        this.record(target, ok);
      }),
    );
  }

  start(): void {
    if (this.timer) return;
    void this.round(); // do not wait a whole interval for the first answer
    this.timer = setInterval(() => void this.round(), this.intervalMs);
    this.timer.unref(); // the timer alone must not keep the process alive
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async round(): Promise<void> {
    if (this.roundRunning) return; // a slow round must not pile up behind itself
    this.roundRunning = true;
    try {
      await this.checkOnce();
    } finally {
      this.roundRunning = false;
    }
  }

  private record(target: Target, ok: boolean): void {
    let streak = this.streaks.get(target);
    if (!streak) {
      streak = { ok: 0, bad: 0 };
      this.streaks.set(target, streak);
    }
    if (ok) {
      streak.ok++;
      streak.bad = 0;
      if (!target.healthy && streak.ok >= this.healthyThreshold) {
        this.balancer.setHealthy(target, true, `${streak.ok} health checks passed`);
      }
    } else {
      streak.bad++;
      streak.ok = 0;
      if (target.healthy && streak.bad >= this.unhealthyThreshold) {
        this.balancer.setHealthy(target, false, `${streak.bad} health checks failed`);
      }
    }
  }
}
