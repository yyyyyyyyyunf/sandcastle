import type { OutputDefinition } from "./Output.js";
import {
  runHostCommand,
  validHostCommand,
  type HostCommandOptions,
} from "./HostCommand.js";
import type { VerificationOptions } from "./Verification.js";
import { gitOutput } from "./gitOutput.js";

export interface PreparationOptions extends HostCommandOptions {}
export interface PreparationContext {
  readonly version: 1;
  readonly iterationId: string;
  readonly hostRepoDir: string;
  readonly targetBranch: string;
  readonly targetCommit: string;
}
export interface PreparationDecision {
  readonly version: 1;
  readonly decision: "run" | "no-work" | "blocked";
  readonly metadata?: unknown;
}
export type RunStopReason =
  | "retained"
  | "no-work"
  | "blocked"
  | "iteration-limit";

export class PreparationError extends Error {
  constructor(
    readonly kind:
      | "configuration"
      | "command"
      | "protocol"
      | "timeout"
      | "changed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PreparationError";
  }
}

/** Preparation describes an exact target snapshot, not a movable branch name. */
export const assertPreparedTarget = async (
  context: PreparationContext,
): Promise<void> => {
  const branch = await gitOutput(
    context.hostRepoDir,
    "symbolic-ref",
    "--short",
    "HEAD",
  );
  const commit = await gitOutput(context.hostRepoDir, "rev-parse", "HEAD");
  if (branch !== context.targetBranch || commit !== context.targetCommit)
    throw new PreparationError(
      "changed",
      "Prepared target changed before allocation or agent invocation",
    );
};

export const validatePreparation = (options: {
  preparation?: PreparationOptions;
  iterationOutput?: OutputDefinition;
  output?: OutputDefinition;
  maxIterations?: number;
  verification?: VerificationOptions;
  resumeSession?: string;
  forkSession?: boolean;
}): void => {
  const native = options.preparation || options.iterationOutput;
  if (options.output && (native || options.verification))
    throw new PreparationError(
      "configuration",
      "legacy output cannot be combined with verification; use iterationOutput",
    );
  if (!native) return;
  if (!options.verification)
    throw new PreparationError(
      "configuration",
      "preparation and iterationOutput require verification",
    );
  if (
    options.maxIterations !== undefined &&
    (!Number.isSafeInteger(options.maxIterations) || options.maxIterations < 1)
  )
    throw new PreparationError(
      "configuration",
      "native iteration maxIterations must be a positive safe integer",
    );
  if (
    options.iterationOutput &&
    (options.iterationOutput.maxRetries ?? 0) !== 0
  )
    throw new PreparationError(
      "configuration",
      "iterationOutput does not retry extraction; maxRetries must be zero",
    );
  if (!options.preparation) return;
  if (!options.verification || !validHostCommand(options.preparation))
    throw new PreparationError(
      "configuration",
      "preparation requires verification, an argv command and a finite positive timeoutSeconds",
    );
  if (options.resumeSession || options.forkSession)
    throw new PreparationError(
      "configuration",
      "preparation cannot resume or fork a previous task session",
    );
};

export const prepareIteration = async (
  options: PreparationOptions,
  context: PreparationContext,
  signal?: AbortSignal,
): Promise<PreparationDecision> => {
  const value = await runHostCommand(
    options,
    context,
    "Preparation",
    (kind, message, options) => new PreparationError(kind, message, options),
    (error) => error instanceof PreparationError,
    signal,
  );
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("decision" in value) ||
    !["run", "no-work", "blocked"].includes(value.decision as string)
  )
    throw new PreparationError(
      "protocol",
      "Invalid preparation decision; expected version 1 and run/no-work/blocked",
    );
  return value as PreparationDecision;
};
