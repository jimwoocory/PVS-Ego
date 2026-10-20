import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

/** Reapplied after local generation; generated dependencies are never committed. */
export function hardenPrismaClient(root){
  const dir=path.join(root,'node_modules/.prisma/client');
  if(fs.realpathSync.native(dir)!==dir)throw Error('SHARED_GENERATED_CLIENT_DENIED');
  const prefix="const __pvsIsolatedBoundary = globalThis[Symbol.for('pvs.isolation.boundary.v1')];\nif (!__pvsIsolatedBoundary) throw new Error('ISOLATION_GUARD_REQUIRED_BEFORE_PRISMA_IMPORT');\n__pvsIsolatedBoundary.assertEnvironment();\n\n";
  const manifest=[],names=['index.js','default.js','client.js','index-browser.js','edge.js','wasm.js'];
  // Even a later layout check failure leaves every known entry guard-protected.
  for(const name of names){
    const file=path.join(dir,name),code=fs.readFileSync(file,'utf8');
    if(fs.statSync(file).nlink!==1)throw Error('SHARED_GENERATED_CLIENT_FILE_DENIED');
    if(!code.startsWith('const __pvsIsolatedBoundary'))fs.writeFileSync(file,prefix+code);
  }
  for(const name of names){
    const file=path.join(dir,name);let code=fs.readFileSync(file,'utf8');
    if(fs.statSync(file).nlink!==1)throw Error('SHARED_GENERATED_CLIENT_FILE_DENIED');
    if(!code.startsWith('const __pvsIsolatedBoundary'))code=prefix+code;
    code=code.replace(/("(?:rootEnvPath|schemaEnvPath)"\s*:)\s*"[^"\r\n]*"/g,'$1 null');
    if(['index.js','edge.js'].includes(name)&&!code.includes('"schemaEnvPath":'))code=code.replace('"relativeEnvPaths": {','"relativeEnvPaths": {\n    "schemaEnvPath": null,');
    code=code.replace('const PrismaClient = getPrismaClient(config)',"const PrismaClient = new Proxy(getPrismaClient(config), {construct(Target, args, NewTarget) { __pvsIsolatedBoundary.assertClientOptions(args[0]); return Reflect.construct(Target, args, NewTarget); }})");
    if(/const PrismaClient = getPrismaClient\(config\)/.test(code))throw Error('PRISMA_CONSTRUCTOR_UNPROTECTED');
    if(['index.js','edge.js'].includes(name)&&(!code.includes('__pvsIsolatedBoundary.assertClientOptions(args[0])')||!code.includes('"schemaEnvPath": null')||!code.includes('"rootEnvPath": null')))throw Error('UNRECOGNIZED_GENERATED_CLIENT_LAYOUT');
    fs.writeFileSync(file,code);manifest.push({name,sha256:createHash('sha256').update(code).digest('hex')});
  }
  return manifest;
}
