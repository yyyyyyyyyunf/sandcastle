import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { run, type RunResult } from "./run.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";

const itPosix = process.platform === "win32" ? it.skip : it;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

itPosix.each([
  { name: "clean", fails: false },
  { name: "failed", fails: true },
])(
  "a later $name iteration retains earlier recovery references",
  async ({ fails }) => {
    const dir = await mkdtemp(join(tmpdir(), "run-recovery-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir, stdio: "pipe" });
      git("init", "-b", "main");
      await writeFile(join(dir, ".gitignore"), ".sandcastle/\n");
      git("add", ".");
      git("commit", "-m", "fixture");
      let calls = 0;
      const result = await run({
        cwd: dir,
        sandbox: noSandbox(),
        prompt: "fixture",
        maxIterations: 2,
        branchStrategy: { type: "merge-to-head" },
        agent: {
          name: "recovery-fixture",
          env: {},
          captureSessions: false,
          buildPrintCommand: () => ({
            command: `${quote(process.execPath)} -e ${quote(++calls === 1 ? "require('node:fs').writeFileSync('unfinished', 'first attempt')" : fails ? "require('node:fs').writeFileSync('unfinished', 'second attempt'); process.exit(1)" : "console.log('second attempt')")}`,
          }),
          parseStreamLine: () => [],
        },
      }).catch((error) => error as RunResult);
      const paths = result.preservedWorktreePaths ?? [];
      expect(calls).toBe(2);
      expect(paths).toHaveLength(fails ? 2 : 1);
      expect(result.preservedWorktreePath).toBe(paths.at(-1));
      expect(await readFile(join(paths[0]!, "unfinished"), "utf8")).toBe(
        "first attempt",
      );
      expect(
        git("worktree", "list", "--porcelain")
          .toString()
          .match(/^worktree /gm),
      ).toHaveLength(fails ? 3 : 2);
      expect(result.iterations).toHaveLength(fails ? 1 : 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
