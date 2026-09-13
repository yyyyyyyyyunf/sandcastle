import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { run } from "./run.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";

const itPosix = process.platform === "win32" ? it.skip : it;
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

itPosix(
  "rejects oversized agent output before invoking the checker",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "verify-output-limit-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir, stdio: "pipe" });
      git("init", "-b", "main");
      await writeFile(join(dir, ".gitignore"), ".sandcastle/\n");
      git("add", ".");
      git("commit", "-m", "fixture");
      const head = git("rev-parse", "HEAD").toString();
      let calls = 0;
      const error = await run({
        cwd: dir,
        sandbox: noSandbox(),
        prompt: "fixture",
        maxIterations: 2,
        branchStrategy: { type: "merge-to-head" },
        executionTimeoutSeconds: 5,
        artifacts: { root: ".sandcastle/evidence", paths: ["acceptance/runs"] },
        verification: {
          command: [
            process.execPath,
            "-e",
            "require('node:fs').writeFileSync('.sandcastle/checked','yes');console.log(JSON.stringify({version:1,decision:'accept'}))",
          ],
          timeoutSeconds: 3,
        },
        agent: {
          name: "fixture",
          env: {},
          captureSessions: false,
          buildPrintCommand: () => {
            calls++;
            return {
              command: `${quote(process.execPath)} -e ${quote("console.log('x'.repeat(17*1024*1024));setInterval(()=>{},1000);")}`,
            };
          },
          parseStreamLine: (line) => [{ type: "text" as const, text: line }],
        },
      }).catch((error) => error);
      expect(error.message).toContain(
        "Guarded iteration output exceeded 16 MiB",
      );
      expect(error.preservedWorktreePaths).toHaveLength(1);
      expect(calls).toBe(1);
      expect(git("rev-parse", "HEAD").toString()).toBe(head);
      await expect(
        readFile(join(dir, ".sandcastle/checked")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

itPosix(
  "checks output emitted during completion-triggered termination",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "verify-completion-"));
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
      const agent = `const fs=require('node:fs');fs.mkdirSync('acceptance/runs',{recursive:true});
      process.on('SIGTERM',()=>{fs.writeFileSync('acceptance/runs/proof','TERM handler ran');console.log('TERMINATION-TAIL');setTimeout(()=>process.exit(0),20);});
      console.log('<promise>COMPLETE</promise>');setInterval(()=>{},1000);`;
      const checker = `const fs=require('node:fs'),assert=require('node:assert/strict');const ctx=JSON.parse(fs.readFileSync(0,'utf8'));
      assert.equal(fs.readFileSync(ctx.artifactRoot+'/acceptance/runs/proof','utf8'),'TERM handler ran');
      const result=JSON.parse(fs.readFileSync(ctx.resultPath,'utf8'));
      assert.ok(result.stdout.includes('TERMINATION-TAIL'));assert.ok(result.rawStdout.includes('TERMINATION-TAIL'));
      console.log(JSON.stringify({version:1,decision:'retain'}));`;
      const result = await run({
        cwd: dir,
        sandbox: noSandbox(),
        prompt: "fixture",
        maxIterations: 2,
        completionTimeoutSeconds: 0.1,
        executionTimeoutSeconds: 5,
        branchStrategy: { type: "merge-to-head" },
        artifacts: { root: ".sandcastle/evidence", paths: ["acceptance/runs"] },
        verification: {
          command: [process.execPath, "-e", checker],
          timeoutSeconds: 3,
        },
        agent: {
          name: "fixture",
          env: {},
          captureSessions: false,
          buildPrintCommand: () => ({
            command: `${quote(process.execPath)} -e ${quote(agent)}`,
          }),
          parseStreamLine: (line) => [{ type: "text" as const, text: line }],
        },
      });
      expect(result.stopReason).toBe("retained");
      const saved = JSON.parse(
        await readFile(result.iterations[0]!.resultPath!, "utf8"),
      );
      expect(saved.stdout).toContain("TERMINATION-TAIL");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
