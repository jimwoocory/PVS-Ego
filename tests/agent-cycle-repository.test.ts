import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {realpathSync} from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaAgentCycleRepository } from "../src/adapters/db/prisma-agent-cycle-repository.js";
import { agentCycleInputSchema, type AgentCycle } from "../src/domain/agent-cycle.js";
import { hashValue } from "../src/domain/hashing.js";
import {PrismaProjectDeletionService} from "../src/adapters/db/prisma-project-deletion-service.js";

const dbPath=process.env.DATABASE_URL?.replace(/^file:/,"")??"";
if(!path.isAbsolute(dbPath)||!realpathSync.native(dbPath).toLowerCase().startsWith(realpathSync.native(os.tmpdir()).toLowerCase()+path.sep))
  throw new Error("Agent repository tests require an explicit database in the OS temporary directory");

test("durable Agent cycles enforce cross-client claim, revision, request key and project ownership",async()=>{
  const db=new PrismaClient(),other=new PrismaClient();
  try{
    const projectId=randomUUID(),secondProject=randomUUID();
    for(const id of [projectId,secondProject])await db.project.create({data:{id,name:"Agent repository isolated test",status:"DRAFT",targetPlatform:"douyin",targetDurationMs:15000,aspectRatio:"9:16"}});
    const repo=new PrismaAgentCycleRepository(db),peer=new PrismaAgentCycleRepository(other);
    const input=agentCycleInputSchema.parse({goal:"验证原任务持久续接",requestKey:randomUUID()});
    const now=new Date().toISOString();
    const cycle:AgentCycle={id:randomUUID(),projectId,input,inputHash:hashValue({projectId,input}),revision:1,status:"READY",steps:0,actions:[],evidence:[],loadedSkills:[],messages:[],createdAt:now,updatedAt:now};
    await repo.create(cycle);
    assert.equal((await peer.create({...cycle,id:randomUUID()})).id,cycle.id);
    await assert.rejects(()=>repo.create({...cycle,id:randomUUID(),inputHash:"f".repeat(64)}),/目标或约束/);
    assert.equal(await peer.get(secondProject,cycle.id),null);
    assert.equal(await peer.claim(secondProject,cycle.id,"intruder"),false);
    const claims=await Promise.all([repo.claim(projectId,cycle.id,"owner-a"),peer.claim(projectId,cycle.id,"owner-b")]);
    assert.equal(claims.filter(Boolean).length,1);
    const owner=claims[0]?"owner-a":"owner-b";
    assert.equal(await repo.recoverAbandoned(projectId,cycle.id),false);
    await assert.rejects(()=>repo.save({...cycle,revision:2,status:"WAITING_USER"},1,"intruder"),/其他操作修改/);
    await repo.save({...cycle,revision:2,status:"WAITING_USER"},1,owner);
    await assert.rejects(()=>repo.save({...cycle,revision:2},1,owner),/其他操作修改/);
    await peer.release(cycle.id,"intruder");
    assert.equal(await peer.claim(projectId,cycle.id,"third"),false);
    await repo.release(cycle.id,owner);
    assert.equal((await peer.get(projectId,cycle.id))?.status,"WAITING_USER");
    assert.equal((await peer.list(projectId))[0]?.id,cycle.id);
    assert.ok(!(await peer.list()).some(c=>c.id===cycle.id));
    await assert.rejects(()=>db.project.delete({where:{id:projectId}}));
    assert.equal((await repo.get(projectId,cycle.id))?.revision,2);
    const projectsRoot=await fs.mkdtemp(path.join(os.tmpdir(),"pvs-agent-delete-"));
    try{
      const deletion=new PrismaProjectDeletionService(db,projectsRoot);
      await assert.rejects(()=>deletion.deleteProject({projectId,confirmName:"Agent repository isolated test"}),/Agent|运营计划/);
      await repo.claim(projectId,cycle.id,"cancel-owner");
      const waiting=(await repo.get(projectId,cycle.id))!;
      await repo.save({...waiting,revision:3,status:"CANCELLED"},2,"cancel-owner");
      await repo.release(cycle.id,"cancel-owner");
      await deletion.deleteProject({projectId,confirmName:"Agent repository isolated test"});
      assert.equal(await repo.get(projectId,cycle.id),null);
      assert.equal(await db.project.findUnique({where:{id:secondProject}})===null,false);
    }finally{await fs.rm(projectsRoot,{recursive:true,force:true});}
  }finally{await Promise.all([db.$disconnect(),other.$disconnect()]);}
});
