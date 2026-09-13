import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { run, type RunResult } from "./run.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";
import { createWorktree } from "./createWorktree.js";
import { createSandbox } from "./createSandbox.js";

const itPosix = process.platform === "win32" ? it.skip : it;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

itPosix.each(["run", "worktree", "sandbox"] as const)(
  "%s preserves declared evidence on success and failure",
  async (entry) => {
    for (const fails of [false, true]) {
      const dir = await mkdtemp(join(tmpdir(), "run-artifacts-"));
      try {
        const git = (...args: string[]) =>
          execFileSync("git", args, { cwd: dir, stdio: "pipe" });
        git("init", "-b", "main");
        await writeFile(
          join(dir, ".gitignore"),
          ".sandcastle/\nacceptance/runs/\n",
        );
        git("add", ".");
        git("commit", "-m", "fixture");
        const originalHead = git("rev-parse", "HEAD").toString().trim();
        const script = `const fs = require('node:fs'); const cp = require('node:child_process'); fs.mkdirSync('acceptance/runs', { recursive: true }); fs.writeFileSync('acceptance/runs/proof.log', 'required evidence'); fs.writeFileSync('delivery.txt', 'delivered'); cp.execFileSync('git', ['add', 'delivery.txt']); cp.execFileSync('git', ['commit', '-m', 'delivery']); process.exit(${fails ? 1 : 0});`;
        let calls = 0;
        const options = {
          cwd: dir,
          sandbox: noSandbox(),
          prompt: "fixture",
          maxIterations: 2,
          branchStrategy: { type: "merge-to-head" as const },
          artifacts: {
            root: ".sandcastle/evidence",
            paths: ["acceptance/runs"],
          },
          agent: {
            name: "artifact-fixture",
            env: {},
            captureSessions: false,
            buildPrintCommand: () => {
              calls++;
              const perIteration = script
                .replaceAll("required evidence", `required evidence ${calls}`)
                .replaceAll("delivered", `delivered ${calls}`);
              return {
                command: `${quote(process.execPath)} -e ${quote(perIteration)}`,
              };
            },
            parseStreamLine: () => [],
          },
        };
        const resource =
          entry === "worktree"
            ? await createWorktree({
                cwd: dir,
                branchStrategy: { type: "merge-to-head" },
              })
            : entry === "sandbox"
              ? await createSandbox({
                  cwd: dir,
                  sandbox: options.sandbox,
                  branch: "candidate",
                })
              : undefined;
        const result = (await (
          resource ? resource.run(options) : run(options)
        ).catch((error) => error)) as RunResult;
        await resource?.close();
        if (fails) {
          expect(result.preservedWorktreePaths).toHaveLength(1);
          expect(git("rev-parse", "HEAD").toString().trim()).toBe(originalHead);
          const record = JSON.parse(
            await readFile(result.runRecordPath!, "utf8"),
          );
          expect(record.status).toBe("failed");
          expect(record.error).toContain("exited with code 1");
          expect(record.iterations[0].candidateCommit).toBe(
            git("rev-parse", record.iterations[0].sourceBranch)
              .toString()
              .trim(),
          );
          expect(
            await readFile(
              join(
                record.iterations[0].artifactRoot,
                "acceptance/runs/proof.log",
              ),
              "utf8",
            ),
          ).toBe("required evidence 1");
          continue;
        }
        expect(result.iterations[0]?.artifactRoot).toBeTypeOf("string");
        expect(
          await readFile(
            join(
              result.iterations[0]!.artifactRoot!,
              "acceptance/runs/proof.log",
            ),
            "utf8",
          ),
        ).toBe("required evidence 1");
        expect(
          git("worktree", "list", "--porcelain")
            .toString()
            .match(/^worktree /gm),
        ).toHaveLength(1);
        expect(
          git(
            "show",
            `${entry === "sandbox" ? "candidate" : "HEAD"}:delivery.txt`,
          ).toString(),
        ).toBe("delivered 2");
        expect(result.runRecordPath).toBeTypeOf("string");
        const record = JSON.parse(
          await readFile(result.runRecordPath!, "utf8"),
        );
        expect(record.status).toBe("completed");
        expect(record.iterations).toHaveLength(2);
        expect(calls).toBe(2);
        expect(
          new Set(result.iterations.map((entry) => entry.artifactRoot)).size,
        ).toBe(2);
        expect(
          await readFile(
            join(
              result.iterations[1]!.artifactRoot!,
              "acceptance/runs/proof.log",
            ),
            "utf8",
          ),
        ).toBe("required evidence 2");
        expect(record.iterations[0]).toMatchObject({
          candidateCommit: result.commits[0]!.sha,
          artifactRoot: result.iterations[0]!.artifactRoot,
          cleanup: entry === "run" ? "removed" : "caller-owned",
        });
        expect(record.iterations[0].mergedCommit).toBe(
          entry === "sandbox" ? undefined : result.commits[0]!.sha,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  },
);

itPosix.each(["worktree", "sandbox"] as const)(
  "%s rejects evidence inside its removable worktree, including aliases",
  async (entry) => {
    const dir = await mkdtemp(join(tmpdir(), "artifact-owned-root-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir, stdio: "pipe" });
      git("init", "-b", "main");
      await writeFile(join(dir, ".gitignore"), ".sandcastle/\n");
      git("add", ".");
      git("commit", "-m", "fixture");
      const resource =
        entry === "worktree"
          ? await createWorktree({
              cwd: dir,
              branchStrategy: { type: "merge-to-head" },
            })
          : await createSandbox({
              cwd: dir,
              sandbox: noSandbox(),
              branch: "candidate",
            });
      let calls = 0;
      try {
        await symlink(resource.worktreePath, join(dir, "alias"), "dir");
        for (const root of [resource.worktreePath, join(dir, "alias")]) {
          await expect(
            resource.run({
              sandbox: noSandbox(),
              prompt: "fixture",
              artifacts: {
                root: join(root, ".sandcastle/evidence"),
                paths: ["acceptance/runs"],
              },
              agent: {
                name: "unused",
                env: {},
                captureSessions: false,
                buildPrintCommand: () => {
                  calls++;
                  return { command: "true" };
                },
                parseStreamLine: () => [],
              },
            }),
          ).rejects.toThrow(
            "Artifact root must be outside removable worktrees",
          );
        }
        expect(calls).toBe(0);
      } finally {
        await resource.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

itPosix.each([false, true])(
  "rejects an artifact root inside an exported directory before allocation (aliased: %s)",
  async (aliased) => {
    const dir = await mkdtemp(join(tmpdir(), "artifact-config-"));
    let allocated = false;
    try {
      if (aliased) {
        await mkdir(join(dir, ".staging/runs"), { recursive: true });
        await symlink(join(dir, ".staging"), join(dir, "acceptance"), "dir");
      }
      const native = noSandbox();
      await expect(
        run({
          cwd: dir,
          prompt: "fixture",
          artifacts: {
            root: aliased
              ? ".staging/runs/evidence"
              : "acceptance/runs/evidence",
            paths: ["acceptance/runs"],
          },
          sandbox: {
            ...native,
            create: async () => {
              allocated = true;
              throw new Error("unexpected allocation");
            },
          },
          agent: {
            name: "unused",
            env: {},
            captureSessions: false,
            buildPrintCommand: () => ({ command: "true" }),
            parseStreamLine: () => [],
          },
        }),
      ).rejects.toThrow("Artifact root must be outside exported directories");
      expect(allocated).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
