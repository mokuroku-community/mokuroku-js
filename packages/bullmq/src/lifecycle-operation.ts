import { InvalidStateError } from "@mokurokujs/core";

import type { JobLifecycleOptions } from "@mokurokujs/core";

/** Validate before creating resources. / リソース作成前に期限を検証する。 */
export function validateLifecycle(options?: JobLifecycleOptions): void {
  const timeout = options?.timeout;
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) {
    throw new InvalidStateError({ message: "timeout must be a finite non-negative number", details: { timeout } });
  }
}

/** A deadline does not cancel cleanup. / 期限後も回収の監視を継続する。 */
export function withDeadline<T>(
  operation: Promise<T>,
  options?: JobLifecycleOptions,
  expired?: () => void,
): Promise<T> {
  if (options?.timeout === undefined) return operation;
  const timeout = options.timeout;
  return new Promise<T>((resolve, reject) => {
    const expire = () => {
      expired?.();
      reject(new InvalidStateError({ message: "Lifecycle operation timed out", details: { timeout } }));
    };
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const remaining = timeout - (Date.now() - started);
      if (remaining <= 0) expire();
      else timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
    };
    if (timeout !== 0) schedule();
    operation.then(
      (value) => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (timer !== undefined) clearTimeout(timer);
        reject(error);
      },
    );
    if (timeout === 0) expire();
  });
}

export function cancelled(): InvalidStateError {
  return new InvalidStateError({ message: "Startup was cancelled", details: { cancelled: true } });
}
