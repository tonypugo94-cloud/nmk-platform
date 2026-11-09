/** JSON-логгер: одна строка — одно событие, удобно для docker logs и сбора логов. */
export type Logger = {
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
  child: (bindings: Record<string, unknown>) => Logger;
};

export function createLogger(bindings: Record<string, unknown> = {}, sink: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
  const write = (level: string, msg: string, data?: Record<string, unknown>) =>
    sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...bindings, ...data }));
  return {
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
    child: (b) => createLogger({ ...bindings, ...b }, sink),
  };
}

export const silentLogger: Logger = createLogger({}, () => {});
