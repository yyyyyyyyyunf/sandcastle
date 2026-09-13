import { execOwnedProcess } from "./execOwnedProcess.js";
import { ExecutionTerminationError } from "./processTermination.js";

export interface HostCommandOptions {
  readonly command: readonly string[];
  readonly timeoutSeconds: number;
}
export const validHostCommand = (options: HostCommandOptions): boolean =>
  Array.isArray(options.command) &&
  options.command.length > 0 &&
  options.command.every(
    (arg) => typeof arg === "string" && !arg.includes("\0"),
  ) &&
  !!options.command[0] &&
  Number.isFinite(options.timeoutSeconds) &&
  options.timeoutSeconds > 0 &&
  options.timeoutSeconds <= 2147483.647;

/** One bounded JSON response, after confirmed process-tree termination. */
export const runHostCommand = async (
  options: HostCommandOptions,
  context: { readonly hostRepoDir: string },
  phase: string,
  error: (
    kind: "command" | "protocol" | "timeout",
    message: string,
    options?: ErrorOptions,
  ) => Error,
  isCommandError: (error: unknown) => boolean,
  signal?: AbortSignal,
): Promise<unknown> => {
  const deadline = new AbortController();
  const timeout = error("timeout", `${phase} command exceeded its deadline`);
  const timer = setTimeout(
    () => deadline.abort(timeout),
    options.timeoutSeconds * 1000,
  );
  const lines: string[] = [];
  let length = 0;
  try {
    const result = await execOwnedProcess(
      options.command[0]!,
      options.command.slice(1),
      {
        cwd: context.hostRepoDir,
        env: process.env,
        stdin: JSON.stringify(context) + "\n",
        signal: signal
          ? AbortSignal.any([signal, deadline.signal])
          : deadline.signal,
        // Decisions are small. Overflow is a protocol error, never a truncated accept.
        onLine: (line) => {
          length += Buffer.byteLength(line) + 1;
          if (length <= 1024 * 1024) lines.push(line);
          else
            deadline.abort(
              error("protocol", `${phase} decision exceeded 1 MiB`),
            );
        },
        maxOutputTailChars: 1024 * 1024,
      },
    );
    if (result.exitCode !== 0)
      throw error(
        "command",
        `${phase} command exited ${result.exitCode}: ${result.stderr}`,
      );
    let value: unknown;
    if (length > 1024 * 1024)
      throw error("protocol", `${phase} decision exceeded 1 MiB`);
    try {
      value = JSON.parse(lines.join("\n"));
    } catch (cause) {
      throw error(
        "protocol",
        `${phase} command did not return one JSON decision`,
        { cause },
      );
    }
    return value;
  } catch (cause) {
    if (
      isCommandError(cause) ||
      cause instanceof ExecutionTerminationError ||
      signal?.aborted
    )
      throw cause;
    throw error("command", `${phase} command failed: ${String(cause)}`, {
      cause,
    });
  } finally {
    clearTimeout(timer);
  }
};
