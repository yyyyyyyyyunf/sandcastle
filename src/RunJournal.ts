import type {
  PreparationContext,
  PreparationDecision,
  RunStopReason,
} from "./Preparation.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ArtifactError, type ArtifactStore } from "./Artifacts.js";
import type {
  VerificationContext,
  VerificationDecision,
} from "./Verification.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await exec("git", args, { cwd, timeout: 5000 })).stdout.trim();

export interface RecordedIteration {
  readonly iterationId: string;
  readonly index: number;
  readonly artifactRoot: string;
  worktreePath?: string;
  sourceBranch?: string;
  targetBranch?: string;
  targetCommit?: string;
  metadata?: unknown;
  output?: unknown;
  rawResultPath?: string;
  resultPath?: string;
  candidateCommit?: string;
  mergedCommit?: string;
  verification?: VerificationDecision;
  verificationContext?: VerificationContext;
  commits?: { sha: string }[];
  cleanup: "pending" | "removed" | "preserved" | "caller-owned" | "failed";
  status: "preparing" | "prepared" | "recorded" | "completed";
}

export interface RunRecord {
  readonly version: 1;
  readonly startedAt: string;
  finishedAt?: string;
  stopReason?: RunStopReason;
  status: "running" | "completed" | "failed";
  error?: string;
  preservedWorktreePaths: string[];
  preparations: {
    context: PreparationContext;
    decision?: PreparationDecision;
  }[];
  iterations: RecordedIteration[];
}

/** Persist recovery references before source cleanup, then record its outcome. */
export class RunJournal {
  readonly path: string;
  private readonly record: RunRecord = {
    version: 1,
    startedAt: new Date().toISOString(),
    status: "running",
    preservedWorktreePaths: [],
    preparations: [],
    iterations: [],
  };
  constructor(private readonly artifacts: ArtifactStore) {
    this.path = join(artifacts.root, "run.json");
  }
  private async save(): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx");
      try {
        await file.writeFile(JSON.stringify(this.record, null, 2) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
    } catch (cause) {
      throw new ArtifactError(
        `Cannot persist run record ${this.path}: ${String(cause)}`,
        { cause },
      );
    }
  }
  async preparing(context: PreparationContext): Promise<void> {
    this.record.preparations.push({ context });
    await this.save();
  }
  async prepared(
    context: PreparationContext,
    decision: PreparationDecision,
  ): Promise<void> {
    const record = this.record.preparations.find(
      (item) => item.context.iterationId === context.iterationId,
    )!;
    record.decision = decision;
    await this.save();
  }
  async begin(
    index: number,
    iterationId: string = randomUUID(),
    metadata?: unknown,
  ): Promise<RecordedIteration> {
    const attempt: RecordedIteration = {
      iterationId,
      metadata,
      index,
      artifactRoot: join(this.artifacts.root, iterationId),
      cleanup: "pending",
      status: "preparing",
    };
    this.record.iterations.push(attempt);
    await this.save();
    return attempt;
  }
  async allocated(attempt: RecordedIteration, worktree: string): Promise<void> {
    attempt.worktreePath = worktree;
    await this.artifacts.assertOutsideWorktree(worktree);
    await this.save();
  }
  async capture(attempt: RecordedIteration, worktree: string): Promise<void> {
    attempt.candidateCommit = await git(worktree, "rev-parse", "HEAD");
    attempt.sourceBranch = await git(
      worktree,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    );
    await this.artifacts.capture(worktree, attempt.iterationId);
    attempt.status = "prepared";
    await this.save();
  }
  async beforeCleanup(
    attempt: RecordedIteration,
    result: { mergedCommit?: string; commits: { sha: string }[] },
  ): Promise<void> {
    attempt.mergedCommit = result.mergedCommit;
    attempt.commits = result.commits;
    attempt.status = "recorded";
    await this.save();
  }
  async result(
    attempt: RecordedIteration,
    result: {
      rawResultPath: string;
      resultPath?: string;
      sourceBranch: string;
      candidateCommit: string;
      targetBranch: string;
      targetCommit: string;
      output?: unknown;
    },
  ): Promise<void> {
    Object.assign(attempt, result);
    await this.save();
  }
  async verified(
    attempt: RecordedIteration,
    context: VerificationContext,
    decision: VerificationDecision,
  ): Promise<void> {
    attempt.verification = decision;
    attempt.verificationContext = context;
    await this.save();
  }
  async completed(
    attempt: RecordedIteration,
    preservedPaths: readonly string[],
  ): Promise<void> {
    const exists = attempt.worktreePath
      ? await stat(attempt.worktreePath).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        )
      : false;
    attempt.cleanup = !exists
      ? "removed"
      : preservedPaths.includes(attempt.worktreePath!)
        ? "preserved"
        : "caller-owned";
    attempt.status = "completed";
    this.record.preservedWorktreePaths = [...preservedPaths];
    await this.save();
  }
  async finish(
    error: string | undefined,
    preservedPaths: readonly string[],
    terminationUnknown = false,
    stopReason?: RunStopReason,
  ): Promise<void> {
    this.record.status = error === undefined ? "completed" : "failed";
    this.record.error = error;
    this.record.stopReason = stopReason;
    this.record.finishedAt = new Date().toISOString();
    this.record.preservedWorktreePaths = [...preservedPaths];
    for (const attempt of this.record.iterations) {
      if (
        error !== undefined &&
        attempt.worktreePath &&
        preservedPaths.includes(attempt.worktreePath)
      ) {
        attempt.cleanup =
          attempt.status === "recorded" ? "failed" : "preserved";
        if (attempt.status === "preparing" && !terminationUnknown) {
          try {
            await this.capture(attempt, attempt.worktreePath);
          } catch (captureError) {
            this.record.error += `\nEvidence recovery: ${String(captureError)}`;
          }
        }
      }
    }
    await this.save();
  }
}
