import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { run } from "./run.js";
import { createWorktree } from "./createWorktree.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";

const itPosix = process.platform === "win32" ? it.skip : it;
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

itPosix.each(["run", "worktree", "nested-sandbox"] as const)(
  "%s verifies stopped execution and durable evidence before accepting or retaining",
  async (entry) => {
    for (const decision of ["accept", "retain"]) {
      const dir = await mkdtemp(join(tmpdir(), "run-verification-"));
      try {
        const git = (...args: string[]) =>
          execFileSync("git", args, { cwd: dir, stdio: "pipe" })
            .toString()
            .trim();
        git("init", "-b", "main");
        await writeFile(
          join(dir, ".gitignore"),
          ".sandcastle/\nacceptance/runs/\n",
        );
        git("add", ".");
        git("commit", "-m", "fixture");
        const target = git("rev-parse", "HEAD");
        let calls = 0;
        const checker = `const fs=require('node:fs'), cp=require('node:child_process'), assert=require('node:assert/strict');
          assert.equal(process.argv[1], '$literal; shell | text');
          const ctx=JSON.parse(fs.readFileSync(0,'utf8'));
          assert.equal(ctx.version,1); assert.ok(ctx.iterationId);
          assert.equal(cp.execFileSync('git',['rev-parse','HEAD'],{cwd:ctx.hostRepoDir}).toString().trim(),ctx.targetCommit);
          assert.equal(fs.readFileSync(ctx.artifactRoot+'/acceptance/runs/proof.log','utf8'),'proof');
          const result=JSON.parse(fs.readFileSync(ctx.resultPath,'utf8'));
          assert.ok(result.stdout.startsWith('FIRST')); assert.ok(result.stdout.endsWith('LAST'));
          if (${JSON.stringify(entry)} !== 'nested-sandbox') assert.equal(fs.readFileSync(ctx.hostRepoDir+'/.sandcastle/stopped','utf8'),'yes');
          fs.writeFileSync(ctx.hostRepoDir+'/.sandcastle/checked.json',JSON.stringify(ctx));
          console.log(JSON.stringify({version:1,decision:${JSON.stringify(decision)},outcome:{status:${JSON.stringify(decision === "accept" ? "passed" : "held")}}}));`;
        const native = noSandbox({ maxOutputTailChars: 32 });
        const options = {
          cwd: dir,
          prompt: "fixture",
          maxIterations: decision === "retain" ? 2 : 1,
          branchStrategy: { type: "merge-to-head" as const },
          artifacts: {
            root: ".sandcastle/evidence",
            paths: ["acceptance/runs"],
          },
          verification: {
            command: [
              process.execPath,
              "-e",
              checker,
              "$literal; shell | text",
            ],
            timeoutSeconds: 5,
          },
          sandbox: {
            ...native,
            create: async (opts: Parameters<typeof native.create>[0]) => {
              const handle = await native.create(opts);
              return {
                ...handle,
                close: async () => {
                  await handle.close();
                  await writeFile(join(dir, ".sandcastle/stopped"), "yes");
                },
              };
            },
          },
          agent: {
            name: "verification-fixture",
            env: {},
            captureSessions: false,
            buildPrintCommand: () => {
              calls++;
              return {
                command: `${quote(process.execPath)} -e ${quote("const fs=require('node:fs'),cp=require('node:child_process'); fs.mkdirSync('acceptance/runs',{recursive:true}); fs.writeFileSync('acceptance/runs/proof.log','proof'); fs.writeFileSync('delivery','candidate'); cp.execFileSync('git',['add','delivery']); cp.execFileSync('git',['commit','-m','delivery']); console.log('FIRST'+ 'x'.repeat(70000) +'LAST');")}`,
              };
            },
            parseStreamLine: () => [],
          },
        };
        const wt =
          entry !== "run"
            ? await createWorktree({
                cwd: dir,
                branchStrategy: options.branchStrategy,
              })
            : undefined;
        const nested =
          entry === "nested-sandbox"
            ? await wt!.createSandbox({ sandbox: options.sandbox })
            : undefined;
        const result = await (nested
          ? nested.run(options)
          : wt
            ? wt.run(options)
            : run(options));
        await nested?.close();
        await wt?.close();
        const ctx = JSON.parse(
          await readFile(join(dir, ".sandcastle/checked.json"), "utf8"),
        );
        expect(calls).toBe(1);
        expect(result.iterations[0]!.verification).toMatchObject({
          decision,
          outcome: { status: decision === "accept" ? "passed" : "held" },
        });
        expect(git("rev-parse", "HEAD")).toBe(
          decision === "accept" ? ctx.candidateCommit : target,
        );
        const record = JSON.parse(
          await readFile(result.runRecordPath!, "utf8"),
        );
        expect(record.iterations[0].verification.decision).toBe(decision);
        if (decision === "retain") {
          expect(result.stopReason).toBe("retained");
          expect(result.preservedWorktreePaths).toContain(ctx.worktreePath);
          expect(
            await readFile(join(ctx.worktreePath, "delivery"), "utf8"),
          ).toBe("candidate");
          expect(git("rev-parse", ctx.sourceBranch)).toBe(ctx.candidateCommit);
          expect(record.iterations[0].cleanup).toBe("preserved");
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  },
  15000,
);

itPosix.each(["head", "branch", "missing-artifacts", "bad-timeout"])(
  "rejects unsafe guarded configuration before agent allocation: %s",
  async (mode) => {
    let calls = 0;
    const options = {
      cwd: tmpdir(),
      prompt: "fixture",
      branchStrategy:
        mode === "branch"
          ? { type: "branch" as const, branch: "candidate" }
          : {
              type:
                mode === "head"
                  ? ("head" as const)
                  : ("merge-to-head" as const),
            },
      artifacts:
        mode === "missing-artifacts"
          ? undefined
          : { root: ".sandcastle/evidence", paths: ["acceptance/runs"] },
      verification: {
        command: [process.execPath, "-e", ""],
        timeoutSeconds: mode === "bad-timeout" ? Infinity : 1,
      },
      sandbox: {
        ...noSandbox(),
        create: async () => {
          calls++;
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
    };
    await expect(run(options)).rejects.toMatchObject({ kind: "configuration" });
    expect(calls).toBe(0);
  },
);
