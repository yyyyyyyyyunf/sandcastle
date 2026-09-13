import { ExecutionTerminationError } from "./processTermination.js";

const shutdowns = new WeakMap<object, Promise<void>>();

/** One bounded shutdown per owned handle, including repeated release paths. */
export const closeSandboxHandle = (handle: {
  close(): Promise<void>;
}): Promise<void> => {
  const prior = shutdowns.get(handle);
  if (prior) return prior;
  const shutdown = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => handle.close()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Shutdown did not finish within 7 seconds")),
            7000,
          );
        }),
      ]);
    } catch (cause) {
      throw new ExecutionTerminationError(
        `Sandbox shutdown failed: ${String(cause)}`,
        { cause },
      );
    } finally {
      clearTimeout(timer);
    }
  })();
  shutdowns.set(handle, shutdown);
  return shutdown;
};
