import test from "node:test";
import assert from "node:assert/strict";
import {
  parseStrictJsonResponse,
  StructuredAiRuntimeError
} from "../src/adapters/ai/hermes-structured-ai-runtime.js";
import { HermesStructuredAiRuntime } from "../src/adapters/ai/hermes-structured-ai-runtime.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

test("Hermes sends real image bytes as native attachments and removes temporary files after failure", async () => {
  let attachment="";
  const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=","base64");
  const runtime=new HermesStructuredAiRuntime("C:\\PVS", "hermes", async(_exe,args)=>{
    attachment=args[args.indexOf("--image")+1]!;
    assert.deepEqual(await fs.readFile(attachment),bytes);
    return {stdout:"",stderr:"synthetic transport failure",exitCode:1,timedOut:false};
  });
  await assert.rejects(runtime.generateJson({task:"inspect",instructions:"JSON",input:{},outputContract:{},media:[{type:"image",mimeType:"image/png",dataBase64:bytes.toString("base64")}]}),/synthetic transport failure/);
  await assert.rejects(fs.stat(attachment));
});

test("visual fallback evidence is invalidated when the current model configuration changes", async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"pvs-vision-proof-test-"));
  const previous=process.env.HERMES_HOME;
  try {
    process.env.HERMES_HOME=root;
    const config=path.join(root,"config.yaml"); await fs.writeFile(config,"model: verified-model\n");
    const proofRoot=path.join(root,".runtime-secrets","ai"); await fs.mkdir(proofRoot,{recursive:true});
    await fs.writeFile(path.join(proofRoot,"hermes-vision-proof.json"),JSON.stringify({version:1,passed:true,configPath:config,configSha256:createHash("sha256").update(await fs.readFile(config)).digest("hex")}));
    const runtime=new HermesStructuredAiRuntime(root);
    assert.equal(await runtime.supportsCapabilities(["VISION"]),true);
    assert.equal(await runtime.supportsCapabilities(["AUDIO"]),false);
    await fs.writeFile(config,"model: another-model\n");
    assert.equal(await runtime.supportsCapabilities(["VISION"]),false);
  } finally {
    if(previous===undefined)delete process.env.HERMES_HOME;else process.env.HERMES_HOME=previous;
    assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
    await fs.rm(root,{recursive:true,force:true});
  }
});

test("full Agent capability prompts cross the process boundary intact without Windows argv overflow", async () => {
  const payload = "行业视频、评论与回执：'\"`$()\\\n".repeat(8000);
  let received = "";
  const runtime = new HermesStructuredAiRuntime("C:\\PVS 项目", "hermes", async (_exe, args, _timeout, input) => {
    assert.ok(args.join(" ").length < 1000);
    assert.equal(args.includes(payload), false);
    assert.deepEqual(args.slice(-4), ["--oneshot", "--quiet", "--query-file", "-"]);
    received = input ?? "";
    return {stdout:'{"ok":true}', stderr:"", exitCode:0, timedOut:false};
  });
  assert.deepEqual(await runtime.generateJson({task:"large catalog", instructions:"只输出JSON", input:{payload}, outputContract:{ok:true}}), {ok:true});
  const body = received.split("INPUT_JSON:\n")[1]!.split("\n\nOUTPUT_CONTRACT_JSON:")[0]!;
  assert.equal(JSON.parse(body).payload, payload);
});

test("Hermes parser accepts standalone and fenced JSON", () => {
  assert.deepEqual(parseStrictJsonResponse('{"ok":true,"items":[1,2]}'), {
    ok: true,
    items: [1, 2]
  });
  const fence = String.fromCharCode(96).repeat(3);
  assert.deepEqual(
    parseStrictJsonResponse(fence + 'json\n{"ok":true}\n' + fence),
    { ok: true }
  );
});

test("Hermes parser tolerates transport prose around exactly one complete JSON value", () => {
  const text =
    "Hermes Agent v0.21.3\n生成完成，结果如下：\n" +
    '{"title":"创意","note":"字符串里允许 {花括号} 和 [方括号]","nested":{"a":[1,2]}}' +
    "\nDone.";
  assert.deepEqual(parseStrictJsonResponse(text), {
    title: "创意",
    note: "字符串里允许 {花括号} 和 [方括号]",
    nested: { a: [1, 2] }
  });
});

test("Hermes parser ignores balanced non-JSON log fragments before the unique JSON result", () => {
  const text = '[INFO]\nstatus={not-json}\nOUTPUT:\n{"ok":true}';
  assert.deepEqual(parseStrictJsonResponse(text), { ok: true });
});

test("Hermes parser fails closed when stdout contains more than one JSON value", () => {
  assert.throws(
    () => parseStrictJsonResponse('{"progress":1}\n{"result":"final"}'),
    (error: unknown) =>
      error instanceof StructuredAiRuntimeError &&
      /多个 JSON/.test(error.message)
  );
});

test("Hermes parser fails closed on truncated or non-JSON output", () => {
  const fence = String.fromCharCode(96).repeat(3);
  for (const text of ['{"broken":', "Hermes says hello", fence + 'json\n{"x":1\n' + fence]) {
    assert.throws(
      () => parseStrictJsonResponse(text),
      (error: unknown) =>
        error instanceof StructuredAiRuntimeError &&
        /不是唯一且完整的 JSON/.test(error.message)
    );
  }
});

test("Hermes parser strips ANSI transport color before parsing", () => {
  assert.deepEqual(
    parseStrictJsonResponse("\u001b[32mRESULT\u001b[0m\n{\"ok\":true}"),
    { ok: true }
  );
});
