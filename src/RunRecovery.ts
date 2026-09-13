import type { IterationResult } from "./Orchestrator.js";

/** Recovery references remain available even if a later iteration fails. */
export interface RunRecovery {
  runRecordPath?: string;
  readonly iterations: IterationResult[];
  readonly preservedWorktreePaths: string[];
  readonly preservedWorktreePath?: string;
}

export const createRunRecovery = (): RunRecovery => ({
  iterations: [],
  preservedWorktreePaths: [],
});

export const recordPreservedWorktree = (
  recovery: RunRecovery,
  path: string,
): void => {
  if (!recovery.preservedWorktreePaths.includes(path))
    recovery.preservedWorktreePaths.push(path);
};

/** Used only when the original failure cannot carry recovery fields. */
export class RunRecoveryError extends Error implements RunRecovery {
  readonly runRecordPath?: string;
  readonly iterations: IterationResult[];
  readonly preservedWorktreePaths: string[];
  readonly preservedWorktreePath?: string;
  constructor(cause: unknown, recovery: RunRecovery) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.runRecordPath = recovery.runRecordPath;
    this.iterations = [...recovery.iterations];
    this.preservedWorktreePaths = [...recovery.preservedWorktreePaths];
    this.preservedWorktreePath = this.preservedWorktreePaths.at(-1);
  }
}

export const withRunRecovery = (
  error: unknown,
  recovery: RunRecovery,
): unknown => {
  if (
    recovery.iterations.length === 0 &&
    recovery.preservedWorktreePaths.length === 0 &&
    !recovery.runRecordPath
  )
    return error;
  if (
    error !== null &&
    (typeof error === "object" || typeof error === "function")
  ) {
    try {
      Object.defineProperties(error, {
        runRecordPath: { value: recovery.runRecordPath, configurable: true },
        iterations: { value: [...recovery.iterations], configurable: true },
        preservedWorktreePaths: {
          value: [...recovery.preservedWorktreePaths],
          configurable: true,
        },
        preservedWorktreePath: {
          value: recovery.preservedWorktreePaths.at(-1),
          configurable: true,
        },
      });
      return error;
    } catch {
      /* frozen or incompatible failure object */
    }
  }
  return new RunRecoveryError(error, recovery);
};
