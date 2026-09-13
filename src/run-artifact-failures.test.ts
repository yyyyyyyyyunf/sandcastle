import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { run, type RunResult } from "./run.js";
import { Output } from "./Output.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";

const itPosix = process.platform === "win32" ? it.skip : it;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

itPosix.each([
  { fault: "copy", native: false },
  { fault: "record", native: false },
  { fault: "cleanup", native: false },
  { fault: "copy", native: true },
  { fault: "record", native: true },
  { fault: "cleanup", native: true },
] as const)(
  "$fault failure (native=$native) preserves recovery and prevents a second allocation",
  async ({ fault, native }) => {
    const dir = await mkdtemp(join(tmpdir(), "artifact-failure-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir, stdio: "pipe" });
      git("init", "-b", "main");
      await writeFile(
        join(dir, ".gitignore"),
        ".sandcastle/\nacceptance/runs/\nsentinel\n",
      );
      await writeFile(join(dir, "sentinel"), "original user content");
      git("add", ".");
      git("commit", "-m", "fixture");
      const before = git("rev-parse", "HEAD").toString().trim();
      const inject =
        fault === "copy"
          ? `fs.symlinkSync(${JSON.stringify(join(dir, "sentinel"))}, 'acceptance/runs/link');`
          : fault === "record"
            ? `const root = ${JSON.stringify(join(dir, ".sandcastle/evidence"))}; const record = root + '/' + fs.readdirSync(root)[0] + '/run.json'; fs.renameSync(record, record + '.previous'); fs.mkdirSync(record);`
            : `fs.chmodSync(require('node:path').dirname(process.cwd()), 0o500);`;
      let allocations = 0;
      const result = await run({
        cwd: dir,
        sandbox: noSandbox(),
        prompt: "fixture <result>",
        ...(native
          ? {
              preparation: {
                command: [
                  process.execPath,
                  "-e",
                  "console.log(JSON.stringify({version:1,decision:'run'}))",
                ],
                timeoutSeconds: 5,
              },
              verification: {
                command: [
                  process.execPath,
                  "-e",
                  "console.log(JSON.stringify({version:1,decision:'accept'}))",
                ],
                timeoutSeconds: 5,
              },
              iterationOutput: Output.string({ tag: "result" }),
            }
          : {}),
        maxIterations: 2,
        branchStrategy: { type: "merge-to-head" },
        artifacts: { root: ".sandcastle/evidence", paths: ["acceptance/runs"] },
        agent: {
          name: "artifact-fault-fixture",
          env: {},
          captureSessions: false,
          buildPrintCommand: () => {
            allocations++;
            const script = `const fs = require('node:fs'); const cp = require('node:child_process'); fs.mkdirSync('acceptance/runs', {recursive: true}); fs.writeFileSync('acceptance/runs/proof.log', 'evidence'); fs.writeFileSync('delivery.txt', 'candidate'); cp.execFileSync('git', ['add', 'delivery.txt']); cp.execFileSync('git', ['commit', '-m', 'candidate']); ${inject}; console.log('<result>proof</result>');`;
            return {
              command: `${quote(process.execPath)} -e ${quote(script)}`,
            };
          },
          parseStreamLine: () => [],
        },
      }).then(
        () => {
          throw new Error("fault unexpectedly succeeded");
        },
        (error) => error as RunResult,
      );
      expect(allocations).toBe(1);
      expect(result.preservedWorktreePaths).toHaveLength(1);
      expect(result.runRecordPath).toBeTypeOf("string");
      expect(await readFile(join(dir, "sentinel"), "utf8")).toBe(
        "original user content",
      );
      if (fault !== "cleanup")
        expect(git("rev-parse", "HEAD").toString().trim()).toBe(before);
      if (fault === "record") {
        expect(String(result)).toContain("Cannot persist run record");
        const previous = JSON.parse(
          await readFile(result.runRecordPath! + ".previous", "utf8"),
        );
        expect(previous.iterations[0].worktreePath).toBe(
          result.preservedWorktreePaths![0],
        );
      } else {
        const record = JSON.parse(
          await readFile(result.runRecordPath!, "utf8"),
        );
        expect(record.status).toBe("failed");
        expect(record.iterations).toHaveLength(1);
        if (fault === "cleanup")
          expect(
            await readFile(
              join(
                record.iterations[0].artifactRoot,
                "acceptance/runs/proof.log",
              ),
              "utf8",
            ),
          ).toBe("evidence");
      }
    } finally {
      await chmod(join(dir, ".sandcastle/worktrees"), 0o700).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  },
  15000,
);
