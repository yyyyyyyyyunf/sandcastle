import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { run } from "../../src/run.js";
import { Output } from "../../src/Output.js";
import { noSandbox } from "../../src/sandboxes/no-sandbox.js";

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

it("installed shared commands verify two dependent Backlog tasks through the native loop", async () => {
  const skill =
    process.env.SANDCASTLE_WORKFLOW_SKILL_DIR ??
    join(homedir(), ".codex/skills/setup-agent-workflow");
  const cli = join(skill, "scripts/workflow.mjs");
  const { workflowOutputSchema } = await import(
    pathToFileURL(join(skill, "scripts/workflow-output.mjs")).href
  );
  const dir = await mkdtemp(join(tmpdir(), "afk-shared-integration-"));
  try {
    const exec = (command: string, args: string[]) =>
      execFileSync(command, args, {
        cwd: dir,
        env: { ...process.env, BACKLOG_CWD: dir },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const git = (...args: string[]) => exec("git", args);
    const backlog = (...args: string[]) => exec("backlog", args);
    const write = async (path: string, content: string) => {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    };
    git("init", "-b", "main");
    backlog(
      "init",
      "AFK shared proof",
      "--defaults",
      "--integration-mode",
      "none",
      "--check-branches",
      "false",
      "--include-remote",
      "false",
      "--auto-open-browser",
      "false",
    );
    await write(
      ".gitignore",
      ".sandcastle/evidence/\n.sandcastle/logs/\n.sandcastle/worktrees/\nacceptance/runs/\n",
    );
    await write(
      "docs/agents/acceptance.md",
      "Assert the selected delivery file equals its ticket ID and save the assertion log.\n",
    );
    await write(
      ".sandcastle/workflow.json",
      JSON.stringify({
        version: 1,
        tracker: {
          type: "backlog",
          command: ["backlog"],
          directory: "backlog",
        },
        queue: {
          scope: { labels: ["trial"] },
          actor: "@me",
          readyLabel: "ready-for-agent",
          conflictingLabels: [
            "needs-triage",
            "needs-info",
            "ready-for-human",
            "wontfix",
          ],
          excludeLabels: ["spec", "wayfinder:map"],
          readyStatuses: ["To Do"],
          doneStatuses: ["Done"],
        },
        contractPaths: ["docs/agents/acceptance.md", "backlog/config.yml"],
        reportRoot: "acceptance/reports",
        evidenceRoots: ["acceptance/runs"],
      }),
    );
    backlog(
      "task",
      "create",
      "First delivery",
      "--ac",
      "Delivery file contains this ticket ID",
      "--labels",
      "trial,ready-for-agent",
    );
    backlog(
      "task",
      "create",
      "Dependent delivery",
      "--ac",
      "Delivery file contains this ticket ID",
      "--labels",
      "trial,ready-for-agent",
      "--dep",
      "TASK-1",
    );
    git("add", ".");
    git("commit", "-m", "bind queue and acceptance");
    const initial = git("rev-parse", "HEAD");
    const tickets: string[] = [];
    const result = await run({
      cwd: dir,
      prompt:
        "Implement the host-selected ticket and emit <workflow-result> after finalization.",
      maxIterations: 3,
      sandbox: noSandbox(),
      branchStrategy: { type: "merge-to-head" },
      artifacts: { root: ".sandcastle/evidence", paths: ["acceptance/runs"] },
      preparation: {
        command: [
          process.execPath,
          cli,
          "prepare",
          "--config",
          ".sandcastle/workflow.json",
        ],
        timeoutSeconds: 20,
      },
      verification: {
        command: [
          process.execPath,
          cli,
          "verify",
          "--config",
          ".sandcastle/workflow.json",
        ],
        timeoutSeconds: 20,
      },
      iterationOutput: Output.object({
        tag: "workflow-result",
        schema: workflowOutputSchema,
      }),
      agent: {
        name: "scripted-workflow-proof",
        env: {},
        captureSessions: false,
        parseStreamLine: () => [],
        buildPrintCommand: ({ prompt }) => {
          const ctx = JSON.parse(
            prompt.match(
              /<sandcastle-iteration-context>\n([\s\S]*?)\n<\/sandcastle-iteration-context>/,
            )![1]!,
          );
          tickets.push(ctx.metadata.ticketId);
          const script = `const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
          const ctx=${JSON.stringify(ctx)},ticket=ctx.metadata.ticketId,id=ctx.iterationId;
          const exec=(command,args)=>cp.execFileSync(command,args,{env:{...process.env,BACKLOG_CWD:process.cwd()},encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
          const git=(...args)=>exec('git',args),backlog=(...args)=>exec('backlog',args);
          const write=(p,data)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,data);};
          const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
          if(ticket==='TASK-2') assert.equal(fs.readFileSync('delivery-TASK-1','utf8'),'TASK-1');
          write('delivery-'+ticket,ticket);git('add','.');git('commit','-m','implement '+ticket);
          const implementationRevision=git('rev-parse','HEAD');
          assert.equal(fs.readFileSync('delivery-'+ticket,'utf8'),ticket);
          const evidencePath='acceptance/runs/'+ticket+'/'+id+'/checks.log';write(evidencePath,'Assertions: 1 passed\\n');
          const binding={version:1,ticketId:ticket,attemptId:id,verdict:'passed',implementationRevision,artifacts:[{path:evidencePath,sha256:hash(evidencePath)}]};
          const reportPath='acceptance/reports/'+ticket+'-'+id+'.md',receiptPath='acceptance/reports/'+ticket+'-'+id+'.receipt.json';
          const fence=String.fromCharCode(96).repeat(3);
          write(reportPath,'# Acceptance '+ticket+'\\n\\nverdict: passed\\nrequired criteria: 1/1 · required gates: 1/1\\ncode state: '+implementationRevision+'\\n\\n'+fence+'afk-acceptance\\n'+JSON.stringify(binding)+'\\n'+fence+'\\n');
          write(receiptPath,JSON.stringify({...binding,report:{path:reportPath,sha256:hash(reportPath)}}));
          backlog('task','edit',ticket,'-s','Done','--check-ac','1');
          if(ticket==='TASK-1') { assert.equal(fs.existsSync('backlog/completed'),false); fs.mkdirSync('backlog/completed',{recursive:true}); backlog('task','complete',ticket); }
          git('add','.');git('commit','-m','finalize '+ticket);
          assert.equal(git('status','--porcelain'),'');
          console.log('<workflow-result>'+JSON.stringify({attemptId:id,ticketId:ticket,outcome:'completed',receiptPath})+'</workflow-result>');
          console.log('<promise>COMPLETE</promise>');`;
          return { command: `${quote(process.execPath)} -e ${quote(script)}` };
        },
      },
    });
    expect(tickets).toEqual(["TASK-1", "TASK-2"]);
    expect(result.stopReason).toBe("no-work");
    expect(result.iterations).toHaveLength(2);
    expect(result.iterations.map((i) => i.verification?.decision)).toEqual([
      "accept",
      "accept",
    ]);
    expect(result.iterations.map((i) => i.commits?.length)).toEqual([2, 2]);
    expect(result.iterations[0]!.targetCommit).toBe(initial);
    expect(result.iterations[1]!.targetCommit).toBe(
      result.iterations[0]!.mergedCommit,
    );
    for (const iteration of result.iterations) {
      expect((iteration.output as any).attemptId).toBe(iteration.iterationId);
      expect((iteration.verification?.outcome as any).status).toBe("completed");
      expect(
        await readFile(
          join(
            iteration.artifactRoot!,
            "acceptance/runs",
            (iteration.output as any).ticketId,
            iteration.iterationId!,
            "checks.log",
          ),
          "utf8",
        ),
      ).toBe("Assertions: 1 passed\n");
    }
    expect(
      JSON.parse(backlog("task", "view", "TASK-1", "--json")).task.path,
    ).toContain("completed/");
    expect(
      JSON.parse(backlog("task", "view", "TASK-2", "--json")).task.status,
    ).toBe("Done");
    const record = JSON.parse(await readFile(result.runRecordPath!, "utf8"));
    expect(record.preparations).toHaveLength(3);
    expect(record.iterations.map((i: any) => i.cleanup)).toEqual([
      "removed",
      "removed",
    ]);
    expect(git("status", "--porcelain")).toBe("");
    console.log(
      `Shared workflow proof: ${cli}; ${backlog("--version")}; 2 dependent tasks accepted, 3 preparations, 0 remaining work`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
