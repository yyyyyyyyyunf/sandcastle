import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { run } from "./run.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";

const itPosix = process.platform === "win32" ? it.skip : it;

itPosix.each([
  "invalid",
  "overflow",
  "exit",
  "timeout",
  "abort",
  "changed",
  "hook-target",
  "hook-source",
  "prompt-target",
  "prompt-source",
])(
  "preparation %s cannot start an agent and finishes its owned processes before returning",
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), "prepare-failure-"));
    const abort = new AbortController();
    const reason = new Error("cancel preparation");
    let invocation: Promise<any> | undefined;
    let child: number | undefined;
    try {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir, stdio: "pipe" })
          .toString()
          .trim();
      git("init", "-b", "main");
      await writeFile(join(dir, ".gitignore"), ".sandcastle/\n");
      git("add", ".");
      git("commit", "-m", "fixture");
      const promptFile = join(dir, ".sandcastle/prompt.md");
      if (mode.startsWith("prompt-")) {
        await mkdir(join(dir, ".sandcastle"), { recursive: true });
        await writeFile(
          promptFile,
          "!`git " +
            (mode === "prompt-target" ? "-C '" + dir + "' " : "") +
            "commit --allow-empty -m prompt-change`",
        );
      }
      let agents = 0;
      const writer = `const fs=require('node:fs'); process.on('SIGTERM',()=>{});fs.writeFileSync('.sandcastle/pid',String(process.pid));setInterval(()=>fs.appendFileSync('.sandcastle/writes','.'),10);`;
      const command = `const fs=require('node:fs'),cp=require('node:child_process');const mode=${JSON.stringify(mode)};
        if(mode==='timeout'||mode==='abort') cp.spawn(process.execPath,['-e',${JSON.stringify(writer)}],{stdio:'inherit'});
        else if(mode==='invalid') console.log(JSON.stringify({version:2,decision:'run'}));
        else if(mode==='exit') process.exit(8);
        else { if(mode==='overflow') console.log(' '.repeat(1100000)); if(mode==='changed') cp.execFileSync('git',['commit','--allow-empty','-m','concurrent target change']); console.log(JSON.stringify({version:1,decision:'run'})); }`;
      invocation = run({
        cwd: dir,
        ...(mode.startsWith("prompt-") ? { promptFile } : { prompt: "unused" }),
        maxIterations: 2,
        signal: abort.signal,
        hooks:
          mode === "hook-source"
            ? {
                sandbox: {
                  onSandboxReady: [
                    { command: "git commit --allow-empty -m hook-source" },
                  ],
                },
              }
            : mode === "hook-target"
              ? {
                  host: {
                    onSandboxReady: [
                      {
                        command:
                          "git -C '" +
                          dir.replaceAll("'", "'\\''") +
                          "' commit --allow-empty -m 'concurrent hook change'",
                      },
                    ],
                  },
                }
              : undefined,
        sandbox: noSandbox(),
        branchStrategy: { type: "merge-to-head" },
        artifacts: { root: ".sandcastle/evidence", paths: ["proof"] },
        preparation: {
          command: [process.execPath, "-e", command],
          timeoutSeconds: mode === "timeout" ? 0.8 : 5,
        },
        verification: {
          command: [process.execPath, "-e", "process.exit(99)"],
          timeoutSeconds: 5,
        },
        agent: {
          name: "unused",
          env: {},
          captureSessions: false,
          parseStreamLine: () => [],
          buildPrintCommand: () => {
            agents++;
            throw new Error("unexpected agent");
          },
        },
      }).catch((error) => error);
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
        expect(child).toBeTypeOf("number");
        abort.abort(reason);
      }
      const error = await invocation;
      expect(error).toBeInstanceOf(Error);
      expect(agents).toBe(0);
      if (mode === "abort") expect(error).toBe(reason);
      else
        expect(error.kind).toBe(
          mode === "invalid" || mode === "overflow"
            ? "protocol"
            : mode === "exit"
              ? "command"
              : mode.startsWith("hook-") || mode.startsWith("prompt-")
                ? "changed"
                : mode,
        );
      const record = JSON.parse(await readFile(error.runRecordPath, "utf8"));
      expect(record.status).toBe("failed");
      expect(record.preparations).toHaveLength(1);
      expect(record.iterations).toHaveLength(
        mode.startsWith("hook-") || mode.startsWith("prompt-") ? 1 : 0,
      );
      if (mode === "timeout" || mode === "abort") {
        child ??= Number(await readFile(join(dir, ".sandcastle/pid"), "utf8"));
        expect(() => process.kill(child!, 0)).toThrow();
        const writes = await readFile(join(dir, ".sandcastle/writes"), "utf8");
        await delay(100);
        expect(await readFile(join(dir, ".sandcastle/writes"), "utf8")).toBe(
          writes,
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
  15000,
);
