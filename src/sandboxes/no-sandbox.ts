import { observeProcessActivity } from "../observeProcessActivity.js";
/**
 * No-sandbox provider — runs the agent directly on the host with no container isolation.
 *
 * Usage:
 *   import { noSandbox } from "sandcastle/sandboxes/no-sandbox";
 *   await interactive({ agent: claudeCode("claude-opus-4-8"), sandbox: noSandbox() });
 *
 * Accepted by `run()`, `interactive()`, and `createSandbox()`. Skips
 * container isolation entirely — the agent executes on the host. Does not
 * pass `--dangerously-skip-permissions` to the agent — the user manages
 * permissions themselves.
 */

import { spawn, type StdioOptions } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  NoSandboxProvider,
  NoSandboxHandle,
  ExecResult,
  InteractiveExecOptions,
  ExecOptions,
} from "../SandboxProvider.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../boundedTail.js";
import {
  ExecutionTerminationError,
  terminateProcessGroup,
} from "../processTermination.js";

export interface NoSandboxOptions {
  /** Environment variables injected by this provider. Merged at launch time. */
  readonly env?: Record<string, string>;
  /**
   * Maximum number of characters of streamed `exec` output retained per stream
   * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
   *
   * Output is delivered live to `onLine` regardless; this only bounds the tail
   * returned in `ExecResult`, preventing a long-running agent's output from
   * overflowing V8's max string length and crashing the run.
   */
  readonly maxOutputTailChars?: number;
}

/**
 * Create a no-sandbox provider.
 *
 * The returned provider runs the agent directly on the host. All three
 * branch strategies are supported (head, merge-to-head, branch),
 * defaulting to head.
 */
export const noSandbox = (options?: NoSandboxOptions): NoSandboxProvider => ({
  tag: "none",
  name: "no-sandbox",
  env: options?.env ?? {},
  create: async (createOptions): Promise<NoSandboxHandle> => {
    const worktreePath = createOptions.worktreePath;
    const processEnv = { ...process.env, ...createOptions.env };
    const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;
    const active = new Map<AbortController, Promise<ExecResult>>();
    let closed = false;

    const handle: NoSandboxHandle = {
      worktreePath,
      supportsExecCancellation: process.platform !== "win32",

      exec: (command: string, opts?: ExecOptions): Promise<ExecResult> => {
        if (closed) return Promise.reject(new Error("Sandbox closed"));
        if (opts?.signal?.aborted) return Promise.reject(opts.signal.reason);
        const abort = new AbortController();
        opts = {
          ...opts,
          signal: opts?.signal
            ? AbortSignal.any([opts.signal, abort.signal])
            : abort.signal,
        };
        // sudo is a no-op for no-sandbox — the user is already on the host
        const cwd = opts?.cwd ?? worktreePath;
        const isWindows = process.platform === "win32";
        // PowerShell and cmd.exe don't ship `sh`, so on Windows route the
        // command string through cmd.exe instead. `/d` skips AutoRun, `/s`
        // preserves the quoted command verbatim, `/c` runs it and exits.
        // `windowsVerbatimArguments` keeps Node from re-quoting our args.
        const shellCmd = isWindows ? "cmd.exe" : "sh";
        const shellArgs = isWindows
          ? ["/d", "/s", "/c", command]
          : ["-c", command];

        const execution = new Promise<ExecResult>((resolve, reject) => {
          const proc = spawn(shellCmd, shellArgs, {
            cwd,
            env: processEnv,
            stdio: [
              opts?.stdin !== undefined ? "pipe" : "ignore",
              "pipe",
              "pipe",
            ],
            windowsVerbatimArguments: isWindows,
            detached: !isWindows,
          });

          let stopping: Promise<void> | undefined;
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
              if (stopping) reject(opts?.signal?.reason);
              else resolve(result);
            } catch (error) {
              reject(error);
            }
          };

          if (opts?.stdin !== undefined) {
            proc.stdin!.write(opts.stdin);
            proc.stdin!.end();
          }

          proc.on("error", (error) => {
            opts?.signal?.removeEventListener("abort", onAbort);
            reject(new Error(`exec failed: ${error.message}`));
          });

          observeProcessActivity(proc, opts?.onActivity);

          if (opts?.onLine) {
            const onLine = opts.onLine;
            const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
            const stderrTail = new BoundedTail(maxOutputTailChars, "");
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
        active.set(abort, execution);
        void execution.finally(() => active.delete(abort)).catch(() => {});
        return execution;
      },

      interactiveExec: (
        args: string[],
        opts: InteractiveExecOptions,
      ): Promise<{ exitCode: number }> => {
        return new Promise((resolve, reject) => {
          const [cmd, ...rest] = args;
          // Agent CLIs on Windows are typically installed as `.cmd`/`.ps1`
          // npm wrappers; bare `spawn("claude", …)` only resolves `.exe`
          // without `shell: true`, so let cmd.exe handle PATHEXT lookup.
          const proc = spawn(cmd!, rest, {
            cwd: opts.cwd ?? worktreePath,
            env: processEnv,
            stdio: [opts.stdin, opts.stdout, opts.stderr] as StdioOptions,
            shell: process.platform === "win32",
          });

          proc.on("error", (error: Error) => {
            reject(new Error(`exec failed: ${error.message}`));
          });

          proc.on("close", (code: number | null) => {
            resolve({ exitCode: code ?? 0 });
          });
        });
      },

      close: async (): Promise<void> => {
        closed = true;
        const executions = [...active.values()];
        for (const abort of active.keys())
          abort.abort(new Error("Sandbox closed"));
        await Promise.all(
          executions.map((execution) =>
            execution.catch((error) => {
              if (error instanceof ExecutionTerminationError) throw error;
            }),
          ),
        );
      },
    };

    return handle;
  },
});
