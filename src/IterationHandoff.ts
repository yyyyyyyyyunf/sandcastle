import {
  assertPreparedTarget,
  PreparationError,
  type PreparationContext,
} from "./Preparation.js";
import { gitOutput } from "./gitOutput.js";

/** Host identity delivered after prompt expansion, before agent invocation. */
export interface IterationHandoff extends PreparationContext {
  readonly metadata?: unknown;
  readonly sourceBranch: string;
  readonly worktreePath: string;
  readonly sandboxRepoDir: string;
  readonly artifactRoot: string;
  readonly outputTag?: string;
}

export const createIterationHandoff = async (
  target: PreparationContext,
  execution: Pick<
    IterationHandoff,
    | "metadata"
    | "worktreePath"
    | "sandboxRepoDir"
    | "artifactRoot"
    | "outputTag"
  > & { baseHead: string },
): Promise<IterationHandoff> => {
  const { baseHead, ...locations } = execution;
  if (baseHead !== target.targetCommit)
    throw new PreparationError(
      "changed",
      "Prepared target or source baseline changed before agent invocation",
    );
  const sourceBranch = await gitOutput(
    execution.worktreePath,
    "symbolic-ref",
    "--short",
    "HEAD",
  );
  return { ...target, ...locations, sourceBranch };
};

export const appendIterationHandoff = async (
  prompt: string,
  context: IterationHandoff,
): Promise<string> => {
  await assertPreparedTarget(context);
  if (
    (await gitOutput(context.worktreePath, "rev-parse", "HEAD")) !==
      context.targetCommit ||
    (await gitOutput(
      context.worktreePath,
      "symbolic-ref",
      "--short",
      "HEAD",
    )) !== context.sourceBranch
  )
    throw new PreparationError(
      "changed",
      "Source baseline changed during prompt preparation",
    );
  return (
    prompt +
    "\n\n<sandcastle-iteration-context>\n" +
    JSON.stringify(context).replaceAll("<", "\\u003c") +
    "\n</sandcastle-iteration-context>"
  );
};
