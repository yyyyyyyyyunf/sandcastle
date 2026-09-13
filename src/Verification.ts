import { gitOutput } from "./gitOutput.js";
import { execOwnedProcess } from "./execOwnedProcess.js";
import { ExecutionTerminationError } from "./processTermination.js";

export interface VerificationOptions {
  readonly command: readonly string[];
  readonly timeoutSeconds: number;
}

export interface VerificationDecision {
  readonly version: 1;
  readonly decision: "accept" | "retain";
  readonly outcome?: unknown;
}

export interface CandidateContext {
  readonly hostRepoDir: string;
  readonly worktreePath: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly targetCommit: string;
  readonly candidateCommit: string;
}

export interface VerificationContext extends CandidateContext {
  readonly version: 1;
  readonly iterationId: string;
  readonly artifactRoot: string;
  readonly resultPath: string;
}

export class VerificationError extends Error {
  constructor(
    readonly kind:
      | "configuration"
      | "command"
      | "protocol"
      | "timeout"
      | "changed"
      | "merge",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export const validateVerification = (
  verification: VerificationOptions | undefined,
  strategy: string,
  artifacts: unknown,
): void => {
  if (!verification) return;
  if (strategy !== "merge-to-head" || !artifacts)
    throw new VerificationError(
      "configuration",
      "verification requires explicit merge-to-head and artifacts",
    );
  if (process.platform === "win32")
    throw new VerificationError(
      "configuration",
      "verification requires confirmed POSIX process cancellation",
    );
  if (
    !Array.isArray(verification.command) ||
    verification.command.length === 0 ||
    verification.command.some(
      (arg) => typeof arg !== "string" || arg.includes("\0"),
    ) ||
    !verification.command[0] ||
    !Number.isFinite(verification.timeoutSeconds) ||
    verification.timeoutSeconds <= 0 ||
    verification.timeoutSeconds > 2147483.647
  )
    throw new VerificationError(
      "configuration",
      "verification requires an argv command and a finite positive timeoutSeconds",
    );
};

export const verifyCandidate = async (
  options: VerificationOptions,
  context: VerificationContext,
  signal?: AbortSignal,
): Promise<VerificationDecision> => {
  const deadline = new AbortController();
  const timeout = new VerificationError(
    "timeout",
    "Verification command exceeded its deadline",
  );
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
              new VerificationError(
                "protocol",
                "Verification decision exceeded 1 MiB",
              ),
            );
        },
        maxOutputTailChars: 1024 * 1024,
      },
    );
    if (result.exitCode !== 0)
      throw new VerificationError(
        "command",
        `Verification command exited ${result.exitCode}: ${result.stderr}`,
      );
    let value: unknown;
    if (length > 1024 * 1024)
      throw new VerificationError(
        "protocol",
        "Verification decision exceeded 1 MiB",
      );
    try {
      value = JSON.parse(lines.join("\n"));
    } catch (cause) {
      throw new VerificationError(
        "protocol",
        "Verification command did not return one JSON decision",
        { cause },
      );
    }
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !("version" in value) ||
      value.version !== 1 ||
      !("decision" in value) ||
      (value.decision !== "accept" && value.decision !== "retain")
    )
      throw new VerificationError(
        "protocol",
        "Invalid verification decision; expected version 1 and accept/retain",
      );
    return value as VerificationDecision;
  } catch (cause) {
    if (
      cause instanceof VerificationError ||
      cause instanceof ExecutionTerminationError ||
      signal?.aborted
    )
      throw cause;
    throw new VerificationError(
      "command",
      `Verification command failed: ${String(cause)}`,
      { cause },
    );
  } finally {
    clearTimeout(timer);
  }
};

export const assertVerificationGit = async (
  verification: VerificationOptions | undefined,
  cwd: string,
): Promise<void> => {
  if (!verification) return;
  const version = await gitOutput(cwd, "version");
  const match = /^git version (\d+)\.(\d+)/.exec(version);
  if (
    !match ||
    Number(match[1]) < 2 ||
    (Number(match[1]) === 2 && Number(match[2]) < 30)
  )
    throw new VerificationError(
      "configuration",
      "verification requires Git 2.30 or newer for reference transactions",
    );
};
