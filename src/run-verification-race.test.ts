import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { run } from "./run.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";

const itPosix = process.platform === "win32" ? it.skip : it;
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

itPosix.each(["before-update", "while-updating"])(
  "protects checked identities from changes %s",
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), "verify-race-"));
    const originalPath = process.env.PATH;
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    try {
      const git = (...args: string[]) =>
        execFileSync(realGit, args, { cwd: dir, stdio: "pipe" })
          .toString()
          .trim();
      git("init", "-b", "main");
      await writeFile(join(dir, ".gitignore"), ".sandcastle/\n");
      git("add", ".");
      git("commit", "-m", "fixture");
      await mkdir(join(dir, ".sandcastle/bin"), { recursive: true });
      const wrapper = join(dir, ".sandcastle/bin/git");
      await writeFile(
        wrapper,
        `#!${process.execPath}
const cp=require('node:child_process'),fs=require('node:fs');
const root=${JSON.stringify(dir)}, mode=${JSON.stringify(mode)}, git=${JSON.stringify(realGit)}, args=process.argv.slice(2), marker=root+'/.sandcastle/inject.json';
if (process.cwd()===root && (mode==='before-update'?['merge','update-ref'].includes(args[0]):args[0]==='read-tree') && fs.existsSync(marker)) {
 const ctx=JSON.parse(fs.readFileSync(marker)); fs.unlinkSync(marker);
 if(mode==='before-update') {
  const head=cp.execFileSync(git,['rev-parse',ctx.candidateCommit+'^'],{cwd:root}).toString().trim();
  cp.execFileSync(git,['reset','--hard',head],{cwd:root,stdio:'pipe'});
  fs.writeFileSync(root+'/.sandcastle/concurrent-head',head);
 } else {
  for(const cwd of [ctx.worktreePath,root]) {
   let failed=false;
   try { cp.execFileSync(git,['symbolic-ref','HEAD','refs/heads/main'],{cwd,stdio:'pipe'}); }
   catch { failed=true; }
   if(!failed) { console.error('HEAD was not locked: '+cwd); process.exit(99); }
  }
  fs.writeFileSync(root+'/.sandcastle/heads-locked','yes');
 }
}
try { cp.execFileSync(git,args,{stdio:'inherit'}); } catch(e) {process.exit(e.status || 1);}
`,
      );
      await chmod(wrapper, 0o755);
      process.env.PATH = join(dir, ".sandcastle/bin") + ":" + originalPath;
      const checker =
        "const fs=require('node:fs');const ctx=JSON.parse(fs.readFileSync(0,'utf8'));fs.writeFileSync(ctx.hostRepoDir+'/.sandcastle/inject.json',JSON.stringify(ctx));console.log(JSON.stringify({version:1,decision:'accept'}));";
      const result = await run({
        cwd: dir,
        sandbox: noSandbox(),
        prompt: "fixture",
        maxIterations: 1,
        branchStrategy: { type: "merge-to-head" },
        artifacts: { root: ".sandcastle/evidence", paths: ["acceptance/runs"] },
        verification: {
          command: [process.execPath, "-e", checker],
          timeoutSeconds: 5,
        },
        agent: {
          name: "fixture",
          env: {},
          captureSessions: false,
          buildPrintCommand: () => ({
            command: `${quote(process.execPath)} -e ${quote("const cp=require('node:child_process');cp.execFileSync('git',['commit','--allow-empty','-m','first']);cp.execFileSync('git',['commit','--allow-empty','-m','second']);")}`,
          }),
          parseStreamLine: () => [],
        },
      }).catch((error) => error);
      if (mode === "before-update") {
        expect(result).toBeInstanceOf(Error);
        expect(git("rev-parse", "HEAD")).toBe(
          await readFile(join(dir, ".sandcastle/concurrent-head"), "utf8"),
        );
        expect(result.preservedWorktreePaths).toHaveLength(1);
      } else {
        expect(result).not.toBeInstanceOf(Error);
        expect(
          await readFile(join(dir, ".sandcastle/heads-locked"), "utf8"),
        ).toBe("yes");
        expect(git("rev-parse", "HEAD")).toBe(result.commits.at(-1).sha);
      }
    } finally {
      process.env.PATH = originalPath;
      await rm(dir, { recursive: true, force: true });
    }
  },
  15_000,
);
