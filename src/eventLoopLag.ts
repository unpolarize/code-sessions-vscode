import { monitorEventLoopDelay } from "node:perf_hooks";

/** Log a STALL tag when p99 exceeds this (performance.md budget is p99 < 50 ms). */
export const LAG_STALL_MS = 200;
export const LAG_LOG_INTERVAL_MS = 30_000;

export function formatLagLine(p50: number, p99: number): string {
  const stall = p99 > LAG_STALL_MS ? " STALL" : "";
  return `[lag] p50=${p50.toFixed(1)}ms p99=${p99.toFixed(1)}ms${stall}`;
}

/** Sample ext-host event-loop lag every 30 s onto an output channel. */
export function startEventLoopLagMonitor(
  appendLine: (line: string) => void,
  intervalMs = LAG_LOG_INTERVAL_MS,
): { dispose(): void } {
  const hist = monitorEventLoopDelay({ resolution: 20 });
  hist.enable();
  const timer = setInterval(() => {
    const p50 = hist.percentile(50) / 1e6;
    const p99 = hist.percentile(99) / 1e6;
    appendLine(formatLagLine(p50, p99));
    hist.reset();
  }, intervalMs);
  timer.unref?.();
  return {
    dispose() {
      clearInterval(timer);
      hist.disable();
    },
  };
}
