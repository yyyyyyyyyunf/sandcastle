import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";
import type { ExecOptions, ExecResult } from "./SandboxProvider.js";
import { BoundedTail, MAX_TAIL_CHARS } from "./boundedTail.js";
import { terminateProcessGroup } from "./processTermination.js";
import { observeProcessActivity } from "./observeProcessActivity.js";

interface OwnedProcessOptions extends Omit<ExecOptions, "stdin"> {
  readonly stdin?: string | ((stream: Writable) => void);
  readonly env: NodeJS.ProcessEnv;
  readonly windowsVerbatimArguments?: boolean;
  readonly maxOutputTailChars?: number;
}

/** One invocation owns its process group until exit and confirmed termination. */
export const execOwnedProcess = (
  command: string,
  args: readonly string[],
  options: OwnedProcessOptions,
): Promise<ExecResult> => {
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);
  const opts = options;
  const cwd = options.cwd;
  const isWindows = process.platform === "win32";
  return new Promise<ExecResult>((resolve, reject) => {
    const proc = spawn(command, [...args], {
      cwd,
      env: options.env,
      stdio: [opts?.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      windowsVerbatimArguments: options.windowsVerbatimArguments,
      detached: !isWindows,
    });

    let stopping: Promise<void> | undefined;
    let stdinError: Error | undefined;
    const onAbort = () => {
      if (proc.pid === undefined || stopping) return;
      stopping = terminateProcessGroup(proc.pid);
      // Report failure without creating an unhandled rejection while
      // stdio close is pending. A successful stop still waits for close.
      stopping.catch(reject);
    };
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts?.signal?.aborted) onAbort();
    const finish = async (result: ExecResult) => {
      opts?.signal?.removeEventListener("abort", onAbort);
      try {
        await stopping;
        // A parent may exit after redirecting a background child's
        // stdio. EOF then proves nothing about the rest of its group.
        if (!stopping && proc.pid !== undefined && !isWindows) {
          await terminateProcessGroup(proc.pid);
        }
        if (stopping) reject(opts?.signal?.reason ?? stdinError);
        else if (stdinError) reject(stdinError);
        else resolve(result);
      } catch (error) {
        reject(error);
      }
    };

    if (opts?.stdin !== undefined) {
      // A command may exit before consuming input. EPIPE is reflected by its
      // exit/result; other input failures still wait for process cleanup.
      proc.stdin!.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") stdinError = error;
      });
      if (typeof opts.stdin === "string") proc.stdin!.end(opts.stdin);
      else {
        try {
          opts.stdin(proc.stdin!);
        } catch (cause) {
          stdinError =
            cause instanceof Error ? cause : new Error(String(cause));
          if (proc.pid !== undefined) {
            stopping = terminateProcessGroup(proc.pid);
            stopping.catch(reject);
          }
        }
      }
    }

    proc.on("error", (error) => {
      opts?.signal?.removeEventListener("abort", onAbort);
      reject(new Error(`exec failed: ${error.message}`));
    });

    observeProcessActivity(proc, opts?.onActivity);

    if (opts?.onLine) {
      const onLine = opts.onLine;
      const stdoutTail = new BoundedTail(
        options.maxOutputTailChars ?? MAX_TAIL_CHARS,
        "\n",
      );
      const stderrTail = new BoundedTail(
        options.maxOutputTailChars ?? MAX_TAIL_CHARS,
        "",
      );
      const rl = createInterface({ input: proc.stdout! });
      rl.on("line", (line) => {
        stdoutTail.push(line);
        onLine(line);
      });
      proc.stderr!.on("data", (chunk: Buffer) => {
        stderrTail.push(chunk.toString());
      });
      proc.on("close", (code) => {
        void finish({
          stdout: stdoutTail.toString(),
          stderr: stderrTail.toString(),
          exitCode: code ?? 128,
        });
      });
    } else {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      proc.stdout!.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk.toString());
      });
      proc.stderr!.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk.toString());
      });
      proc.on("close", (code) => {
        void finish({
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
          exitCode: code ?? 128,
        });
      });
    }
  });
};
