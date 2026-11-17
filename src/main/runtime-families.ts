import {constants,createReadStream,promises as fs} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {gameRuntimeSelection,runtimeFamilies,runtimeFamilyLabels,runtimeFamilyArch,type RuntimeFamily,type InstalledRuntimeFamily,runtimeBuildApproval,sameRuntimeBuild,type RuntimeBuildApproval} from '../shared/runtime-selection.js';
const repositories:Record<RuntimeFamily,string>={nexus:'domsvoboda/nexus-runtime','nexus-cachyos':'domsvoboda/nexus-runtime-cachyos'};
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const NEXUS_CI_COMPAT_SOURCE = 'efa482d163cbd299602bce12317d863a1fda384c';
// Exact three regular license files present in the fully validated Standard CI
// archive but absent from its generated manifest. They are accepted only for
// this exact family, source commit and schema; any other extra remains an error.
const NEXUS_CI_COMPAT_LICENSE:Readonly<Record<string,string>>=Object.freeze({
  'files/share/doc/nexus-runtime/GCC-runtime-copyright':'20390f8a6f3b1e4d7cb45dd8652dabb259bbef688cbad839bcdb0b9ba7252f79',
  'files/share/doc/nexus-runtime/MinGW-runtime-copyright':'50e5bb66d222c7d4692c2d13670ddcd3664779358e389a026b69a0e0e18e7be5',
  'files/share/doc/nexus-runtime/libxml2-COPYING':'c5c63674f8a83c4d2e385d96d1c670a03cb871ba2927755467017317878574bd',
});
async function fileDigest(file:string) {
  const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');
}
const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const commit=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const within=(root:string,file:string)=>{const relative=path.relative(root,file);return Boolean(relative)&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
/** Files that every verified managed family payload must carry, per exact
 * payload architecture. The loader/server directory, pristine prefix and the
 * primary PE module directory come from the producer's target: x64 uses
 * `bin`/`default_pfx`/`x86_64-windows`, ARM64 uses
 * `bin-arm64`/`default_pfx_arm64`/`aarch64-windows` while keeping the emulated
 * i386 and x86_64 module directories. */
const launchLayouts=Object.freeze({
  x64:{bin:'files/bin',prefix:'files/share/default_pfx',primaryPe:'x86_64'},
  arm64:{bin:'files/bin-arm64',prefix:'files/share/default_pfx_arm64',primaryPe:'aarch64'},
} as const);
const familyModules=['xgameruntime.dll','winhttp.dll','libnghttp2.dll'];
/** Module directories the contract requires. The x64 contract keeps its
 * original x86_64 + i386 set. The ARM64 contract additionally requires the
 * primary aarch64 modules plus the emulated x86_64 (ARM64EC) and i386 (WoW64/FEX)
 * modules, because games load x86 binaries through them. */
const requiredModuleDirs=Object.freeze({x64:['x86_64','i386'],arm64:['aarch64','x86_64','i386']} as const);
function criticalPayload(arch:'x64'|'arm64'):string[] {
  const layout=launchLayouts[arch];
  return ['proton',layout.bin+'/wine',layout.bin+'/wineserver',layout.bin+'/wine.nexus-original','XODUS_NEXUS_PATCH.json',
    ...['PlayFabGameSave.dll','gaming-services-version.exe','package-registration.exe'].map(name=>'files/share/xodus-nexus/compat/'+name),
    ...requiredModuleDirs[arch].flatMap(cpu=>familyModules.map(name=>`files/lib/wine/${cpu}-windows/${name}`))];
}
/** The only absolute link a managed payload may contain: the inert Z: drive
 * mapping of this architecture's own default template. x64 has only
 * default_pfx and ARM64 only default_pfx_arm64, so the exception cannot be
 * borrowed from the other architecture's prefix. */
const templateMappings=Object.freeze({x64:'files/share/default_pfx/dosdevices/z:',arm64:'files/share/default_pfx_arm64/dosdevices/z:'} as const);
const templateMapping=(name:string,target:unknown,arch:'x64'|'arm64'):boolean=>name===templateMappings[arch]&&target==='/';
/** Build identity metadata that an ARM64 payload may declare. It must agree
 * with the verified architecture and the producer's fixed target layout; an
 * x64 manifest that starts claiming ARM64 layout is rejected. */
function arm64Metadata(metadata:Record<string,unknown>):void {
  if(metadata.targetArchitecture!=='arm64')throw Error('ARM64 runtime payload must declare its target architecture');
  if(metadata.binDirectory!=='bin-arm64'||metadata.defaultPrefix!=='default_pfx_arm64')throw Error('ARM64 runtime payload declares a different launcher layout');
  const components=metadata.componentsByArch;
  if(!components||typeof components!=='object'||Array.isArray(components)||typeof (components as Record<string,unknown>)['aarch64-windows']!=='object'||(components as Record<string,unknown>)['aarch64-windows']===null)throw Error('ARM64 runtime payload must bind its aarch64-windows modules');
}
/** Native ARM64 entry points. Only the ARM64 family is inspected: a payload of
 * the other host architecture can never be launched as this native runtime. */
const ARM64_LOADERS=Object.freeze(['files/bin-arm64/wine','files/bin-arm64/wineserver','files/bin-arm64/wine.nexus-original']);
const ELF_MAGIC=Buffer.from([0x7f,0x45,0x4c,0x46]),EM_AARCH64=183;
/** A real 64-bit little-endian aarch64 ELF header. The whole identification
 * block is validated, not just e_machine: magic, EI_CLASS=2, EI_DATA=1,
 * EI_VERSION=1 and e_machine 183. A 64-byte non-ELF blob or an x86_64 header is
 * rejected. The check is capped at the first 64 bytes of a regular file. */
async function isArm64Elf(file:string):Promise<boolean> {
  if(!(await fs.lstat(file)).isFile())return false;
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const header=Buffer.alloc(64),{bytesRead}=await handle.read(header,0,64,0);
    return bytesRead===64&&header.subarray(0,4).equals(ELF_MAGIC)&&header[4]===2&&header[5]===1&&header[6]===1&&header.readUInt16LE(18)===EM_AARCH64;
  }finally{await handle.close();}
}
async function verifyArm64Loaders(base:string):Promise<void> {
  for(const name of ARM64_LOADERS)if(!await isArm64Elf(path.join(base,name)))throw Error('ARM64 runtime loader is not a native aarch64 executable: '+name);
}
export interface ResolvedRuntimeFamily extends InstalledRuntimeFamily {
  readonly winePath:string;readonly root:string;readonly arch:'x64'|'arm64';readonly prefixSchema:1;readonly manifestSha256:string;
}
/** Retained receipts live outside the fully inventoried payload. A directory
 * alone never authorizes a build. Existing current-only installs remain valid
 * only while current still identifies the exact approved build. */
async function receiptFile(runtimeRoot:string,id:RuntimeFamily,approved?:Readonly<RuntimeBuildApproval>):Promise<string> {
  const directory=path.join(runtimeRoot,'variants',id);
  if(approved) {
    const receipts=path.join(directory,'receipts'),file=path.join(receipts,approved.buildId+'.json');
    try {
      if(!(await fs.lstat(receipts)).isDirectory()||!within(await fs.realpath(directory),await fs.realpath(receipts)))throw Error('Invalid retained receipt directory');
      if(!(await fs.lstat(file)).isFile())throw Error('Retained receipt must be a regular file');
      return file;
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  return path.join(directory,'current.json');
}
/** Read a receipt written by a verified managed installer, never a user-supplied
 * executable. A missing or damaged selected family cannot fall back to default. */
async function verifyRuntimeFamily(runtimeRoot:string,selection:unknown,arch:string=process.arch,approved?:Readonly<RuntimeBuildApproval>):Promise<Readonly<ResolvedRuntimeFamily>> {
  const id=gameRuntimeSelection(selection);
  if(id==='default')throw Error('Default runtime resolution requires the existing global runtime.');
  // No managed family payload exists for any other host, so no fallback.
  if(arch!=='x64'&&arch!=='arm64')throw Error('Unsupported runtime architecture.');
  try {
    const managedRoot=await fs.realpath(runtimeRoot);
    const directory=path.join(runtimeRoot,'variants',id);
    if(!within(managedRoot,await fs.realpath(directory)))throw Error('Family directory leaves managed root');
    const file=await receiptFile(runtimeRoot,id,approved);
    if(!(await fs.lstat(file)).isFile())throw Error('Receipt must be a regular file');
    const pointer=JSON.parse(await fs.readFile(file,'utf8'));
    if(approved&&!sameRuntimeBuild(approved,pointer))throw Error('Approved runtime receipt identity mismatch');
    if(pointer.schema!==1||pointer.family!==id||pointer.sourceRepository!==repositories[id]||!commit(pointer.sourceCommit)||!hash(pointer.manifestSha256)||!hash(pointer.buildId))throw Error('Invalid managed runtime receipt');
    const requestedRoot=path.join(directory,'releases',pointer.buildId);
    if(!(await fs.lstat(requestedRoot)).isDirectory())throw Error('Runtime root must be a real directory');
    const root=await fs.realpath(requestedRoot);
    const releases=await fs.realpath(path.join(directory,'releases'));
    if(!within(managedRoot,releases)||!within(releases,root))throw Error('Runtime build leaves its managed directory');
    return await verifyRuntimeFamilyPayload(root,pointer,arch);
  }catch(error){throw Error(`${runtimeFamilyLabels[id]} is unavailable or failed verification. Reinstall this selected runtime; the default was not used.`,{cause:error});}
}
export interface RuntimeFamilyReceipt {schema:1;family:RuntimeFamily;sourceRepository:string;sourceCommit:string;manifestSha256:string;buildId:string;}
/** Integrity validation only. Installation authority must come from a verified
 * published archive; this function never adopts a folder or writes receipts. */
export async function verifyRuntimeFamilyPayload(root:string,pointer:RuntimeFamilyReceipt,arch:string=process.arch):Promise<Readonly<ResolvedRuntimeFamily>> {
  const id=pointer.family;
  // The requested host architecture is validated before any payload path is
  // derived; an archive of another architecture is never used as a fallback.
  const payloadArch=runtimeFamilyArch(arch);
  // The reviewed ARM64 payload contract exists for the Standard family only. An
  // ARM64 CachyOS receipt/manifest is refused here as well, so no future or
  // hand-written receipt can adopt one; there is no fallback to another family.
  if(payloadArch==='arm64'&&id==='nexus-cachyos')throw Error('ARM64 managed runtime is available for the Standard runtime only');
  if(!runtimeFamilies.includes(id)||pointer.schema!==1||pointer.sourceRepository!==repositories[id]||!commit(pointer.sourceCommit)||!hash(pointer.manifestSha256)||!hash(pointer.buildId))throw Error('Invalid managed runtime receipt');
  if(!(await fs.lstat(root)).isDirectory())throw Error('Runtime root must be a real directory');
  // Callers may supply a lexical staging or destination path whose ancestors
  // contain symlinks (for example /home -> /var/home). The leaf guard above
  // stays lexical, then every check and returned path uses one canonical base.
  const base=await fs.realpath(root);
    if(!(await fs.lstat(path.join(base,'nexus-family.json'))).isFile())throw Error('Runtime manifest must be a regular file');
    const bytes=await fs.readFile(path.join(base,'nexus-family.json'));
    if(digest(bytes)!==pointer.manifestSha256)throw Error('Runtime manifest checksum mismatch');
    const manifest=JSON.parse(bytes.toString('utf8'));
    if(manifest.schema!==1||manifest.family!==id||manifest.sourceRepository!==repositories[id]||manifest.sourceCommit!==pointer.sourceCommit||manifest.buildId!==pointer.buildId||manifest.arch!==payloadArch||manifest.prefixSchema!==1||!manifest.files||Array.isArray(manifest.files)||typeof manifest.files!=='object')throw Error('Runtime manifest identity mismatch');
    const compatLicense=id==='nexus'&&pointer.schema===1&&pointer.sourceCommit===NEXUS_CI_COMPAT_SOURCE?NEXUS_CI_COMPAT_LICENSE:{};
    const layout=launchLayouts[payloadArch],loader=layout.bin+'/wine',server=layout.bin+'/wineserver';
    // Installer manifests must cover the Proton entry point and complete payload
    // of this exact architecture: the native loader/server, the ARM64 primary
    // aarch64 modules plus the emulated x86_64 and i386 modules when applicable.
    const critical=criticalPayload(payloadArch);
    for(const required of critical)if(!hash(manifest.files[required]))throw Error('Runtime launch file missing');
    for(const [name,expected] of Object.entries(manifest.files)) {
      if(!hash(expected)||!name||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..')||path.isAbsolute(name))throw Error('Unsafe runtime manifest path');
      if(!(await fs.lstat(path.join(base,name))).isFile())throw Error('Runtime file inventory must name regular files');
      const target=await fs.realpath(path.join(base,name));
      if(!within(base,target)||(await fs.stat(target)).isFile()!==true||await fileDigest(target)!==expected)throw Error('Runtime payload checksum mismatch');
    }
    const symlinks=manifest.symlinks??{};
    if(!symlinks||Array.isArray(symlinks)||typeof symlinks!=='object')throw Error('Invalid runtime symlink inventory');
    for(const [name,target] of Object.entries(symlinks)) {
      if(typeof target!=='string'||!target||path.isAbsolute(target)&&!templateMapping(name,target,payloadArch)||!name||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..')||path.isAbsolute(name)||name in manifest.files)throw Error('Unsafe runtime symlink path');
      const file=path.join(base,name);
      if(!(await fs.lstat(file)).isSymbolicLink()||await fs.readlink(file)!==target||!within(base,await fs.realpath(path.dirname(file)))||!templateMapping(name,target,payloadArch)&&!within(base,await fs.realpath(file)))throw Error('Runtime symlink leaves verified payload');
    }
    const inventory:string[]=[];
    const walk=async(directory:string)=>{for(const item of await fs.readdir(directory,{withFileTypes:true})){
      const file=path.join(directory,item.name),name=path.relative(base,file).split(path.sep).join('/');
      if(item.isDirectory())await walk(file);else if(name!=='nexus-family.json')inventory.push(name);
    }};
    await walk(base);
    const expectedInventory=[...Object.keys(manifest.files),...Object.keys(symlinks),...Object.keys(compatLicense)];
    if(new Set(inventory).size!==inventory.length||inventory.sort().join('\n')!==[...new Set(expectedInventory)].sort().join('\n'))throw Error('Runtime payload inventory is incomplete');
    for(const [name,expected] of Object.entries(compatLicense)) {
      if(name in manifest.files||name in symlinks)continue;
      const file=path.join(base,name),stat=await fs.lstat(file);
      if(!stat.isFile()||stat.isSymbolicLink())throw Error('Compatibility runtime license must be a regular file');
      const target=await fs.realpath(file);
      if(!within(base,target)||!(await fs.stat(target)).isFile()||await fileDigest(target)!==expected)throw Error('Compatibility runtime license checksum mismatch');
    }
    const metadata=JSON.parse(await fs.readFile(path.join(base,'XODUS_NEXUS_PATCH.json'),'utf8'));
    if(metadata.schema!==1||!hash(metadata.sourceLockSha256)||!metadata.sourceGraph||typeof metadata.sourceGraph!=='object'||metadata.sourceGraph.proton!==pointer.sourceCommit||metadata.sourceLockSha256!==manifest.sourceLockSha256)throw Error('Runtime source graph is not bound');
    if(payloadArch==='arm64')arm64Metadata(metadata as Record<string,unknown>);
    // The pristine prefix directory must be the one this architecture's Proton
    // layout uses (default_pfx or default_pfx_arm64), as a real directory.
    if(!(await fs.stat(path.join(base,layout.prefix))).isDirectory())throw Error('Runtime default prefix missing');
    const winePath=path.join(base,loader);
    for(const file of [winePath,path.join(base,'proton'),path.join(base,server)]) {
      if(!(await fs.lstat(file)).isFile())throw Error('Runtime launcher cannot be a symlink');
      await fs.access(file,constants.X_OK);
    }
    // An ARM64 payload must reach this point only with native aarch64 entry
    // points, including when it is a staged payload about to be adopted.
    if(payloadArch==='arm64')await verifyArm64Loaders(base);
    return Object.freeze({id,label:runtimeFamilyLabels[id],buildId:pointer.buildId,sourceCommit:pointer.sourceCommit,winePath,root:base,arch:payloadArch,prefixSchema:1,manifestSha256:pointer.manifestSha256});
}

/** ARM64-native entry points, applied to a freshly verified installed payload
 * and to every cache hit. x64 resolution is unchanged: the x64 payload contract
 * has no native-header requirement, so no x64 behaviour is added or altered.
 * The archive-staging verifier calls the same check before a payload is adopted
 * into the managed tree. */
async function verifyArm64NativeEntrypoints(value:Readonly<ResolvedRuntimeFamily>):Promise<void> {
  if(value.arch==='arm64')await verifyArm64Loaders(value.root);
}
// A cache hit still checks identities and the complete inventory, but never
// reads payload contents. Receipt/manifest/root changes, additions, removals,
// replacements and writes invalidate it. Never cache a concurrently changed scan.
const verified=new Map<string,{fingerprint:string;value:Readonly<ResolvedRuntimeFamily>}>();
const inFlight=new Map<string,Promise<Readonly<ResolvedRuntimeFamily>>>();
let fullPasses=0,cacheHits=0;
export const runtimeFamilyVerificationStats=()=>Object.freeze({fullPasses,cacheHits});
async function runtimeFingerprint(runtimeRoot:string,id:RuntimeFamily,approved?:Readonly<RuntimeBuildApproval>):Promise<string> {
  const hash=createHash('sha256');
  const add=(value:string)=>{hash.update(String(Buffer.byteLength(value)));hash.update(':');hash.update(value);};
  const root=await fs.realpath(runtimeRoot),directory=path.join(runtimeRoot,'variants',id);
  const canonical=await fs.realpath(directory);
  if(!within(root,canonical))throw Error('Family path leaves runtime root');
  add(root);add(canonical);
  const pointerFile=await receiptFile(runtimeRoot,id,approved);
  if(!(await fs.lstat(pointerFile)).isFile())throw Error('Receipt must be a regular file');
  const bytes=await fs.readFile(pointerFile);add(bytes.toString('utf8'));
  const pointer=JSON.parse(bytes.toString('utf8'));
  if(!hashId(pointer.buildId))throw Error('Invalid managed build identity');
  const release=path.join(directory,'releases',pointer.buildId);
  const identity=async(file:string)=>{
    const stat=await fs.lstat(file,{bigint:true});
    add(file);add([stat.dev,stat.ino,stat.mode,stat.nlink,stat.size,stat.mtimeNs,stat.ctimeNs].join(':'));
    if(stat.isSymbolicLink())add(await fs.readlink(file));
    return stat;
  };
  for(const file of [runtimeRoot,directory,path.join(directory,'releases'),pointerFile])await identity(file);
  const walk=async(file:string)=>{
    const stat=await identity(file);
    if(stat.isDirectory())for(const name of (await fs.readdir(file)).sort())await walk(path.join(file,name));
  };
  await walk(release);
  return hash.digest('hex');
}
const hashId=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
async function resolveVerifiedRuntimeFamily(runtimeRoot:string,selection:unknown,arch:string=process.arch,approved?:Readonly<RuntimeBuildApproval>):Promise<Readonly<ResolvedRuntimeFamily>> {
  const id=gameRuntimeSelection(selection);
  if(id==='default')throw Error('Default runtime resolution requires the existing global runtime.');
  const key=JSON.stringify([path.resolve(runtimeRoot),id,arch,approved]);
  const pending=inFlight.get(key);if(pending)return pending;
  const work=(async()=>{
    try {
      const before=await runtimeFingerprint(runtimeRoot,id,approved);
      const previous=verified.get(key);
      if(previous?.fingerprint===before){
        // The ARM64 native header is re-read on every resolution, cache hit or
        // not, so a loader swapped on disk can never be launched from a hit.
        await verifyArm64NativeEntrypoints(previous.value);
        if(await runtimeFingerprint(runtimeRoot,id,approved)!==before)throw Error('Runtime changed during cached verification.');
        cacheHits++;return previous.value;
      }
      verified.delete(key);fullPasses++;
      const value=await verifyRuntimeFamily(runtimeRoot,id,arch,approved);
      await verifyArm64NativeEntrypoints(value);
      if(await runtimeFingerprint(runtimeRoot,id,approved)!==before)throw Error('Runtime changed during verification. Retry after installation finishes.');
      verified.set(key,{fingerprint:before,value});
      while(verified.size>8)verified.delete(verified.keys().next().value!);
      return value;
    }catch(error){verified.delete(key);throw Error(`${runtimeFamilyLabels[id]} is unavailable or failed verification. Reinstall this selected runtime; the default was not used.`,{cause:error});}
  })();
  inFlight.set(key,work);
  try{return await work;}finally{if(inFlight.get(key)===work)inFlight.delete(key);}
}
/** Current build is used by discovery and every new family launch. */
export function resolveRuntimeFamily(runtimeRoot:string,selection:unknown,arch:string=process.arch) {
  return resolveVerifiedRuntimeFamily(runtimeRoot,selection,arch);
}
/** Exact retained-build lookup for rollback/lifetime tooling, not per-game launch selection. */
export async function resolveRuntimeFamilyBuild(runtimeRoot:string,selection:unknown,approval:unknown,arch:string=process.arch) {
  return resolveVerifiedRuntimeFamily(runtimeRoot,selection,arch,runtimeBuildApproval(approval));
}
/** Future installers must call this BEFORE replacing current. Publish only a
 * fully verified current receipt, exclusively and outside the payload. Reads
 * never synthesize receipts or adopt arbitrary release directories. */
export async function retainRuntimeFamilyBuild(runtimeRoot:string,selection:unknown,arch:string=process.arch):Promise<Readonly<ResolvedRuntimeFamily>> {
  const value=await resolveRuntimeFamily(runtimeRoot,selection,arch);
  const directory=path.join(runtimeRoot,'variants',value.id),receipts=path.join(directory,'receipts');
  await fs.mkdir(receipts,{recursive:true,mode:0o700});
  if(!(await fs.lstat(receipts)).isDirectory()||!within(await fs.realpath(directory),await fs.realpath(receipts)))throw Error('Invalid retained receipt directory');
  const familyDirectory=await fs.open(directory,'r');
  try{await familyDirectory.sync();}finally{await familyDirectory.close();}
  const file=path.join(receipts,value.buildId+'.json');
  const record={schema:1,family:value.id,sourceRepository:repositories[value.id],buildId:value.buildId,manifestSha256:value.manifestSha256,sourceCommit:value.sourceCommit};
  const bytes=JSON.stringify(record)+'\n',temporary=path.join(receipts,'.receipt-'+randomUUID());
  try {
    const handle=await fs.open(temporary,'wx',0o600);
    try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    // Revalidate after staging; never bless a changed current installation.
    const latest=await resolveRuntimeFamily(runtimeRoot,selection,arch);
    if(!sameRuntimeBuild(value,latest))throw Error('Current runtime changed before retention');
    try{await fs.link(temporary,file);}catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      if(!(await fs.lstat(file)).isFile()||await fs.readFile(file,'utf8')!==bytes)throw Error('Conflicting retained runtime receipt');
    }
    const handleDirectory=await fs.open(receipts,'r');
    try{await handleDirectory.sync();}finally{await handleDirectory.close();}
    await resolveRuntimeFamilyBuild(runtimeRoot,selection,value,arch);
    return value;
  }finally{await fs.unlink(temporary).catch(()=>undefined);}
}
export async function installedRuntimeFamilies(runtimeRoot:string,arch:string=process.arch):Promise<InstalledRuntimeFamily[]> {
  const results=await Promise.all(runtimeFamilies.map(async (id):Promise<InstalledRuntimeFamily|undefined>=>{
    try{const value=await resolveRuntimeFamily(runtimeRoot,id,arch);return {id:value.id,label:value.label,buildId:value.buildId,sourceCommit:value.sourceCommit,manifestSha256:value.manifestSha256,displayWinePath:value.winePath};}catch{return undefined;}
  }));
  return results.filter((value):value is InstalledRuntimeFamily=>Boolean(value));
}
