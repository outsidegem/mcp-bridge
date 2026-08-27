export class RateLimiter {
  private usage = new Map<string, { count: number; resetAt: number }>();

  constructor(private maxRequests: number = 10, private windowMs: number = 60000) {}

  public checkLimit(agentId: string, toolName: string): boolean {
    const key = `${agentId}:${toolName}`;
    const now = Date.now();
    const record = this.usage.get(key);

    if (!record || now > record.resetAt) {
      this.usage.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    if (record.count >= this.maxRequests) {
      return false;
    }

    record.count++;
    return true;
  }
}
