import type { ChildProcess } from "node:child_process";

/** Report raw activity independently of each provider's line buffering. */
export const observeProcessActivity = (
  process: Pick<ChildProcess, "stdout" | "stderr">,
  onActivity?: () => void,
): void => {
  if (!onActivity) return;
  const observe = (chunk: Buffer) => {
    if (chunk.length > 0) onActivity();
  };
  process.stdout?.on("data", observe);
  process.stderr?.on("data", observe);
};
