import { gitOutput } from "./gitOutput.js";
import {
  runHostCommand,
  validHostCommand,
  type HostCommandOptions,
} from "./HostCommand.js";

export interface VerificationOptions extends HostCommandOptions {}

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
  readonly metadata?: unknown;
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
  if (!validHostCommand(verification))
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
  const value = await runHostCommand(
    options,
    context,
    "Verification",
    (kind, message, options) => new VerificationError(kind, message, options),
    (error) => error instanceof VerificationError,
    signal,
  );
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
