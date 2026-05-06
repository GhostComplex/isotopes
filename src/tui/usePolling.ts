import { useEffect } from "react";

export function usePolling(fn: () => void | Promise<void>, intervalMs: number): void {
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      void fn();
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
}
