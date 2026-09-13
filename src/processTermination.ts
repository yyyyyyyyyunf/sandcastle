import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/** The caller must preserve the execution's workspace when this is thrown. */
export class ExecutionTerminationError extends Error {
  readonly _tag = "ExecutionTerminationError";
  readonly terminationStatus = "unknown";
}

/** Stop only the process group created for this invocation, and confirm exit. */
export const terminateProcessGroup = async (pid: number): Promise<void> => {
  try {
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        execFile(
          "taskkill",
          ["/PID", String(pid), "/T", "/F"],
          { timeout: 5000 },
          (error) => {
            if (error) reject(error);
            else resolve();
          },
        );
      });
      return;
    }
    const exists = () => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        // Darwin can report EPERM for a group containing only zombies before
        // the parent reaps them. Keep waiting; only ESRCH confirms absence.
        if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
        throw error;
      }
    };
    const send = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH" && code !== "EPERM") throw error;
      }
    };
    if (!exists()) return;
    send("SIGTERM");
    const grace = performance.now() + 500;
    while (exists() && performance.now() < grace) await delay(20);
    if (!exists()) return;
    send("SIGKILL");
    const deadline = performance.now() + 5000;
    while (exists() && performance.now() < deadline) await delay(20);
    if (exists())
      throw new Error(`Process group ${pid} remains alive after SIGKILL`);
  } catch (cause) {
    throw new ExecutionTerminationError(
      `Cannot confirm termination of invocation ${pid}: ${String(cause)}`,
      { cause },
    );
  }
};
