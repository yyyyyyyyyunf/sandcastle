import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { run } from "./run.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";

const itPosix = process.platform === "win32" ? it.skip : it;
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

itPosix.each([
  "source",
  "target",
  "source-head",
  "target-head",
  "dirty",
  "merge",
  "invalid",
  "exit",
  "overflow",
  "timeout",
  "abort",
])(
  "verification %s stops without delivering or allocating again",
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), "verify-failure-"));
    const abort = new AbortController();
    const reason = new Error("caller cancelled checker");
    let child: number | undefined;
    let invocation: Promise<unknown> | undefined;
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
      const writes = `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(${JSON.stringify(join(dir, ".sandcastle/pid"))},String(process.pid)); setInterval(()=>fs.appendFileSync(${JSON.stringify(join(dir, ".sandcastle/heartbeat"))},'.'),10);`;
      const checker = `const fs=require('node:fs'),cp=require('node:child_process'); const ctx=JSON.parse(fs.readFileSync(0,'utf8')); fs.writeFileSync(ctx.hostRepoDir+'/.sandcastle/context.json',JSON.stringify(ctx));
        const mode=${JSON.stringify(mode)};
        if(mode==='source'||mode==='target') cp.execFileSync('git',['commit','--allow-empty','-m','concurrent change'],{cwd:mode==='source'?ctx.worktreePath:ctx.hostRepoDir});
        if(mode==='source-head'||mode==='target-head') {
          const cwd=mode==='source-head'?ctx.worktreePath:ctx.hostRepoDir;
          cp.execFileSync('git',['branch','other','HEAD'],{cwd});
          cp.execFileSync('git',['symbolic-ref','HEAD','refs/heads/other'],{cwd});
        }
        if(mode==='dirty') fs.writeFileSync(ctx.worktreePath+'/unverified','changed');
        if(mode==='merge') fs.writeFileSync(ctx.hostRepoDir+'/.git/index.lock','fixture lock');
        if(mode==='invalid') console.log('I am held');
        else if(mode==='exit') process.exit(4);
        else if(mode==='timeout'||mode==='abort') cp.spawn(process.execPath,['-e',${JSON.stringify(writes)}],{stdio:'inherit'});
        else { if(mode==='overflow') console.log(' '.repeat(1100000)); console.log(JSON.stringify({version:1,decision:'accept'})); }`;
      let calls = 0;
      const options = {
        cwd: dir,
        sandbox: noSandbox(),
        prompt: "fixture",
        maxIterations: 2,
        branchStrategy: { type: "merge-to-head" as const },
        signal: abort.signal,
        artifacts: { root: ".sandcastle/evidence", paths: ["acceptance/runs"] },
        verification: {
          command: [process.execPath, "-e", checker],
          timeoutSeconds: mode === "timeout" ? 0.8 : 5,
        },
        agent: {
          name: "fixture",
          env: {},
          captureSessions: false,
          buildPrintCommand: () => {
            calls++;
            return {
              command: `${quote(process.execPath)} -e ${quote("const fs=require('node:fs'),cp=require('node:child_process');fs.writeFileSync('delivery','candidate');cp.execFileSync('git',['add','delivery']);cp.execFileSync('git',['commit','-m','delivery']);")}`,
            };
          },
          parseStreamLine: () => [],
        },
      };
      invocation = run(options).catch((error) => error);
      if (mode === "abort") {
        for (let i = 0; i < 500; i++) {
          const pid = await readFile(
            join(dir, ".sandcastle/pid"),
            "utf8",
          ).catch(() => undefined);
          if (pid) {
            child = Number(pid);
            break;
          }
          await delay(10);
        }
        abort.abort(reason);
      }
      const error = (await invocation) as Error & {
        kind?: string;
        preservedWorktreePaths?: string[];
        runRecordPath?: string;
      };
      expect(error).toBeInstanceOf(Error);
      expect(calls).toBe(1);
      if (mode === "abort") expect(error).toBe(reason);
      else
        expect(error.kind).toBe(
          ["source", "target", "source-head", "target-head", "dirty"].includes(
            mode,
          )
            ? "changed"
            : ["invalid", "overflow"].includes(mode)
              ? "protocol"
              : mode === "exit"
                ? "command"
                : mode,
        );
      const ctx = JSON.parse(
        await readFile(join(dir, ".sandcastle/context.json"), "utf8"),
      );
      expect(error.preservedWorktreePaths).toContain(ctx.worktreePath);
      expect(await readFile(join(ctx.worktreePath, "delivery"), "utf8")).toBe(
        "candidate",
      );
      expect(() => git("cat-file", "-e", "HEAD:delivery")).toThrow();
      expect(git("rev-parse", "HEAD")).not.toBe(ctx.candidateCommit);
      if (mode !== "target") expect(git("rev-parse", "HEAD")).toBe(target);
      const record = JSON.parse(await readFile(error.runRecordPath!, "utf8"));
      expect(record.status).toBe("failed");
      expect(record.iterations).toHaveLength(1);
      if (mode === "timeout" || mode === "abort") {
        child ??= Number(await readFile(join(dir, ".sandcastle/pid"), "utf8"));
        expect(() => process.kill(child!, 0)).toThrow();
        const heartbeat = await readFile(
          join(dir, ".sandcastle/heartbeat"),
          "utf8",
        );
        await delay(100);
        expect(await readFile(join(dir, ".sandcastle/heartbeat"), "utf8")).toBe(
          heartbeat,
        );
      }
    } finally {
      abort.abort(reason);
      await invocation;
      if (child) {
        try {
          process.kill(child, "SIGKILL");
        } catch {}
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
);
