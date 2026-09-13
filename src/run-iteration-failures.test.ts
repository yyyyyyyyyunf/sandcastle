import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { run } from "./run.js";
import { Output, StructuredOutputError } from "./Output.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";

const itPosix = process.platform === "win32" ? it.skip : it;
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

itPosix.each([
  { mode: "missing", failedIteration: 1 },
  { mode: "held", failedIteration: 1 },
  { mode: "missing", failedIteration: 2 },
  { mode: "invalid-json", failedIteration: 2 },
  { mode: "invalid-schema", failedIteration: 2 },
  { mode: "held", failedIteration: 2 },
  { mode: "iteration-limit", failedIteration: 2 },
])(
  "$mode on iteration $failedIteration preserves completed results and prevents another invocation",
  async ({ mode, failedIteration }) => {
    const dir = await mkdtemp(join(tmpdir(), "iteration-failure-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir, stdio: "pipe" })
          .toString()
          .trim();
      git("init", "-b", "main");
      await writeFile(join(dir, ".gitignore"), ".sandcastle/\nproof/\n");
      git("add", ".");
      git("commit", "-m", "fixture");
      const initial = git("rev-parse", "HEAD");
      let calls = 0;
      const result: any = await run({
        cwd: dir,
        prompt: "<result>",
        maxIterations: mode === "iteration-limit" ? 2 : 3,
        sandbox: noSandbox(),
        branchStrategy: { type: "merge-to-head" },
        artifacts: { root: ".sandcastle/evidence", paths: ["proof"] },
        preparation: {
          command: [
            process.execPath,
            "-e",
            "console.log(JSON.stringify({version:1,decision:'run',metadata:{ticket:'opaque'}}))",
          ],
          timeoutSeconds: 5,
        },
        verification: {
          command: [
            process.execPath,
            "-e",
            `const fs=require('node:fs');const ctx=JSON.parse(fs.readFileSync(0,'utf8'));const result=JSON.parse(fs.readFileSync(ctx.resultPath,'utf8')); console.log(JSON.stringify({version:1,decision:result.output.status==='held'?'retain':'accept'}));`,
          ],
          timeoutSeconds: 5,
        },
        iterationOutput: Output.object({
          tag: "result",
          schema: {
            "~standard": {
              version: 1,
              vendor: "fixture",
              validate: (value: any) =>
                typeof value?.status === "string"
                  ? { value }
                  : { issues: [{ message: "status required" }] },
            },
          },
        }),
        agent: {
          name: "failure-fixture",
          env: {},
          captureSessions: false,
          parseStreamLine: () => [],
          buildPrintCommand: () => {
            calls++;
            const output =
              calls < failedIteration || mode === "iteration-limit"
                ? '<result>{"status":"completed"}</result>'
                : mode === "held"
                  ? '<result>{"status":"held"}</result>'
                  : mode === "missing"
                    ? "no result"
                    : mode === "invalid-json"
                      ? "<result>broken</result>"
                      : "<result>{}</result>";
            return {
              command: `${quote(process.execPath)} -e ${quote(`const fs=require('node:fs'),cp=require('node:child_process');fs.writeFileSync('delivery-${calls}','candidate');cp.execFileSync('git',['add','.']);cp.execFileSync('git',['commit','-m','delivery']);fs.mkdirSync('proof',{recursive:true});fs.writeFileSync('proof/log','attempt ${calls}');console.log(${JSON.stringify(output)});console.log('<promise>COMPLETE</promise>');`)}`,
            };
          },
        },
      }).catch((error) => error);
      expect(calls).toBe(failedIteration);
      const record = JSON.parse(await readFile(result.runRecordPath, "utf8"));
      expect(record.iterations).toHaveLength(failedIteration);
      expect(record.preparations).toHaveLength(failedIteration);
      if (failedIteration > 1)
        expect(result.iterations[0].output).toEqual({ status: "completed" });
      const previousCommit =
        failedIteration > 1 ? result.iterations[0].candidateCommit : initial;
      if (mode === "iteration-limit") {
        expect(result.stopReason).toBe("iteration-limit");
        expect(result.iterations).toHaveLength(2);
        expect(git("rev-parse", "HEAD")).toBe(
          result.iterations[1].candidateCommit,
        );
      } else {
        expect(git("rev-parse", "HEAD")).toBe(previousCommit);
        expect(result.preservedWorktreePaths).toHaveLength(1);
        expect(
          await readFile(
            join(
              result.preservedWorktreePaths[0],
              `delivery-${failedIteration}`,
            ),
            "utf8",
          ),
        ).toBe("candidate");
        expect(
          await readFile(
            join(
              record.iterations[failedIteration - 1].artifactRoot,
              "proof/log",
            ),
            "utf8",
          ),
        ).toBe(`attempt ${failedIteration}`);
        const raw = JSON.parse(
          await readFile(
            record.iterations[failedIteration - 1].rawResultPath,
            "utf8",
          ),
        );
        expect(raw.stdout).toContain("<promise>COMPLETE</promise>");
        if (mode === "held") expect(result.stopReason).toBe("retained");
        else {
          expect(result).toBeInstanceOf(StructuredOutputError);
          expect(result.iterations).toHaveLength(failedIteration - 1);
          expect(
            record.iterations[failedIteration - 1].resultPath,
          ).toBeUndefined();
          expect(record.status).toBe("failed");
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  15000,
);

itPosix(
  "legacy output failure retains the completed run recovery references and post-run merge semantics",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "legacy-output-recovery-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir, stdio: "pipe" })
          .toString()
          .trim();
      git("init", "-b", "main");
      await writeFile(join(dir, ".gitignore"), ".sandcastle/\n");
      git("add", ".");
      git("commit", "-m", "fixture");
      const result: any = await run({
        cwd: dir,
        prompt: "<result>",
        maxIterations: 1,
        output: Output.string({ tag: "result" }),
        sandbox: noSandbox(),
        branchStrategy: { type: "merge-to-head" },
        artifacts: { root: ".sandcastle/evidence", paths: ["proof"] },
        agent: {
          name: "legacy-fixture",
          env: {},
          captureSessions: false,
          parseStreamLine: () => [],
          buildPrintCommand: () => ({
            command: `${quote(process.execPath)} -e ${quote("require('node:child_process').execFileSync('git',['commit','--allow-empty','-m','legacy delivery']);console.log('no result');")}`,
          }),
        },
      }).catch((error) => error);
      expect(result).toBeInstanceOf(StructuredOutputError);
      expect(result.iterations).toHaveLength(1);
      expect(result.commits).toHaveLength(1);
      expect(git("rev-parse", "HEAD")).toBe(result.commits[0].sha);
      const record = JSON.parse(await readFile(result.runRecordPath, "utf8"));
      expect(record.iterations[0].cleanup).toBe("removed");
      expect(record.iterations[0].mergedCommit).toBe(result.commits[0].sha);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
