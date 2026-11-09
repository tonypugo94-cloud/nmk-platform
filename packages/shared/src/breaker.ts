/**
 * Предохранитель для синхронных вызовов внешних систем (1С, МетеоПлан, API мессенджеров).
 * После N ошибок подряд перестаёт дёргать систему на cooldownMs и сразу отдаёт ошибку,
 * чтобы сервис не висел на таймаутах. Затем пропускает пробный вызов.
 */
export class CircuitOpenError extends Error {
  constructor(name: string) { super(`circuit "${name}" is open`); }
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  constructor(
    readonly name: string,
    private readonly opts: { threshold?: number; cooldownMs?: number; timeoutMs?: number; now?: () => number } = {},
  ) {}

  get state(): "closed" | "open" | "half-open" {
    if (this.failures < (this.opts.threshold ?? 5)) return "closed";
    return this.now() - this.openedAt >= (this.opts.cooldownMs ?? 30_000) ? "half-open" : "open";
  }

  private now() { return (this.opts.now ?? Date.now)(); }

  async call<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.state === "open") throw new CircuitOpenError(this.name);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 15_000);
    try {
      const result = await fn(ctrl.signal);
      this.failures = 0;
      return result;
    } catch (e) {
      this.failures++;
      if (this.failures >= (this.opts.threshold ?? 5)) this.openedAt = this.now();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
