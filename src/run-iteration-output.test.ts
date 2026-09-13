import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { run } from "./run.js";
import { createWorktree } from "./createWorktree.js";
import { Output } from "./Output.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";

const itPosix = process.platform === "win32" ? it.skip : it;
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

itPosix.each(["inline", "file", "worktree", "nested-sandbox"] as const)(
  "%s: host prepares two independent sessions and records verified merge/cleanup before the next preparation",
  async (entry) => {
    const dir = await mkdtemp(join(tmpdir(), "run-iteration-output-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir, stdio: "pipe" })
          .toString()
          .trim();
      git("init", "-b", "main");
      await writeFile(join(dir, ".gitignore"), ".sandcastle/\nproof/\n");
      git("add", ".");
      git("commit", "-m", "fixture");
      const start = git("rev-parse", "HEAD");
      const preparation = `const fs=require('node:fs'),assert=require('node:assert/strict');
      const ctx=JSON.parse(fs.readFileSync(0,'utf8'));
      const count=Number(fs.existsSync('count')?fs.readFileSync('count','utf8'):0);
      if(count) { const recordPath=fs.readFileSync('.sandcastle/record-path','utf8'); const record=JSON.parse(fs.readFileSync(recordPath,'utf8')); assert.equal(record.iterations.length,count); assert.equal(record.iterations.at(-1).status,'completed'); assert.equal(record.iterations.at(-1).cleanup,${JSON.stringify(entry === "inline" || entry === "file" ? "removed" : "caller-owned")}); assert.equal(record.iterations.at(-1).mergedCommit,ctx.targetCommit); }
      console.log(JSON.stringify({version:1,decision:count===2?'no-work':'run',metadata:{ticketId:'T-'+(count+1),nested:{literal:'<x>!'+String.fromCharCode(96)+'echo unsafe'+String.fromCharCode(96)}}}));`;
      const checker = `const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict'),path=require('node:path');
      const ctx=JSON.parse(fs.readFileSync(0,'utf8')); const result=JSON.parse(fs.readFileSync(ctx.resultPath,'utf8'));
      assert.deepEqual(result.metadata,ctx.metadata); assert.equal(result.iterationId,ctx.iterationId);
      assert.equal(result.output.ticketId,ctx.metadata.ticketId); assert.equal(result.output.attemptId,ctx.iterationId);
      assert.equal(cp.execFileSync('git',['rev-parse','HEAD'],{cwd:ctx.hostRepoDir}).toString().trim(),ctx.targetCommit);
      assert.equal(result.sourceBranch,ctx.sourceBranch); assert.equal(result.candidateCommit,ctx.candidateCommit);
      fs.writeFileSync('.sandcastle/record-path',path.join(path.dirname(ctx.resultPath),'run.json'));
      console.log(JSON.stringify({version:1,decision:'accept',outcome:{status:'completed',ticketId:ctx.metadata.ticketId}}));`;
      const handoffs: any[] = [];
      const promptFile = join(dir, ".sandcastle/prompt.md");
      if (entry !== "inline") {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(join(dir, ".sandcastle"), { recursive: true });
        await writeFile(
          promptFile,
          "source={{SOURCE_BRANCH}} target={{TARGET_BRANCH}} arg={{ARG}} shell=!`echo expanded` <result>",
        );
      }
      const opts = {
        cwd: dir,
        ...(entry === "inline"
          ? { prompt: "literal {{SOURCE_BRANCH}} !`echo untouched` <result>" }
          : {
              promptFile,
              promptArgs: { ARG: "{{SOURCE_BRANCH}} !`echo untouched`" },
            }),
        maxIterations: 3,
        branchStrategy: { type: "merge-to-head" as const },
        sandbox: noSandbox(),
        artifacts: { root: ".sandcastle/evidence", paths: ["proof"] },
        preparation: {
          command: [process.execPath, "-e", preparation],
          timeoutSeconds: 5,
        },
        verification: {
          command: [process.execPath, "-e", checker],
          timeoutSeconds: 5,
        },
        iterationOutput: Output.object({
          tag: "result",
          schema: {
            "~standard": {
              version: 1,
              vendor: "fixture",
              validate: (value: any) =>
                typeof value.attemptId === "string" &&
                typeof value.ticketId === "string"
                  ? { value }
                  : { issues: [{ message: "missing identity" }] },
            },
          },
        }),
        agent: {
          name: "iteration-fixture",
          env: {},
          captureSessions: false,
          buildPrintCommand: ({
            prompt,
            resumeSession,
          }: import("./AgentProvider.js").AgentCommandOptions) => {
            expect(resumeSession).toBeUndefined();
            if (entry === "inline")
              expect(prompt).toContain(
                "literal {{SOURCE_BRANCH}} !`echo untouched`",
              );
            const handoff = JSON.parse(
              prompt.match(
                /<sandcastle-iteration-context>\n([\s\S]*?)\n<\/sandcastle-iteration-context>/,
              )![1]!,
            );
            handoffs.push(handoff);
            if (entry !== "inline") {
              expect(prompt).toContain(
                `source=${handoff.sourceBranch} target=main arg={{SOURCE_BRANCH}} !\`echo untouched\``,
              );
              expect(prompt).toContain("shell=expanded");
            }
            expect(handoff.sourceBranch).toBe(
              execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
                cwd: handoff.worktreePath,
              })
                .toString()
                .trim(),
            );
            return {
              command: `${quote(process.execPath)} -e ${quote(`const fs=require('node:fs'),cp=require('node:child_process'); fs.mkdirSync('proof',{recursive:true}); fs.writeFileSync('proof/agent.log','done'); fs.writeFileSync('count',${JSON.stringify(String(handoffs.length))}); cp.execFileSync('git',['add','count']); cp.execFileSync('git',['commit','-m','delivery']); console.log('<result>'+JSON.stringify(${JSON.stringify({ attemptId: handoff.iterationId, ticketId: handoff.metadata.ticketId })})+'</result>'); console.log('<promise>COMPLETE</promise>');`)}`,
            };
          },
          parseStreamLine: () => [],
        },
      };
      const wt =
        entry === "worktree" || entry === "nested-sandbox"
          ? await createWorktree({
              cwd: dir,
              branchStrategy: opts.branchStrategy,
            })
          : undefined;
      const nested =
        entry === "nested-sandbox"
          ? await wt!.createSandbox({ sandbox: opts.sandbox })
          : undefined;
      const result = await (nested
        ? nested.run(opts)
        : wt
          ? wt.run(opts)
          : run(opts));
      await nested?.close();
      await wt?.close();
      expect(result.stopReason).toBe("no-work");
      expect(result.iterations).toHaveLength(2);
      expect(new Set(handoffs.map((h) => h.iterationId)).size).toBe(2);
      expect(result.iterations.map((i) => i.metadata)).toEqual(
        handoffs.map((h) => h.metadata),
      );
      expect(result.iterations[0]!.targetCommit).toBe(start);
      expect(result.iterations[1]!.targetCommit).toBe(
        result.iterations[0]!.candidateCommit,
      );
      expect(result.iterations[1]!.mergedCommit).toBe(git("rev-parse", "HEAD"));
      expect(result.iterations.map((i) => i.commits?.length)).toEqual([1, 1]);
      expect(result.iterations.map((i) => (i.output as any).ticketId)).toEqual([
        "T-1",
        "T-2",
      ]);
      expect(await readFile(join(dir, "count"), "utf8")).toBe("2");
      const record = JSON.parse(await readFile(result.runRecordPath!, "utf8"));
      expect(record.preparations).toHaveLength(3);
      expect(record.iterations.map((i: any) => i.metadata)).toEqual(
        handoffs.map((h) => h.metadata),
      );
      expect(record.iterations[1].output.ticketId).toBe("T-2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  15000,
);
