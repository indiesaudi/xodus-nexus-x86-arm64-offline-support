import {readFileSync} from 'node:fs';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {expect,it,vi} from 'vitest';
import {catalogDetailMarket,publicStoreMarket} from './public-store-market';
import {gameDetailsTarget} from './game-details-target';
import {AccountLibrary} from './account-library';
import {CatalogService} from './catalog';
import {assertStoreBundleAccess,assertStoreOfferAccess} from './catalog-access';
import {contentParentForChoice,installSelection} from './install-plan';
import {bundleHints,bundleMembership,requestedProductIds,scopedStoreAccess} from './store-bundle-access';
import fixture from './__fixtures__/metro-bundle.json';

// Execute the real main-process declarations from index.ts against a real
// AccountLibrary and a real CatalogService with a synthetic transport. No
// Electron window, account, backend process, license or network is used.
const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
const parsed=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
const names=new Set(['storeAccessContext','assertStoreAccessContext','storeAccess','verifyStoreInstall','startInstall','prepareInstall']);
const functions=parsed.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name&&names.has(node.name.text)).map(node=>node.getText(parsed)).join('\n');
function handler(owner:string,channel:string):string{
 const fn=parsed.statements.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text===owner);
 const found=fn?.body?.statements.find(statement=>ts.isExpressionStatement(statement)&&ts.isCallExpression(statement.expression)
  &&statement.expression.arguments[0]?.getText(parsed)===`'${channel}'`);
 if(!found)throw Error(`Missing ${owner} ${channel}.`);
 return found.getText(parsed);
}
const code=ts.transpileModule([functions,handler('registerIpc','store-access'),'\nglobalThis.entry={storeAccess,verifyStoreInstall,startInstall};'].join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const BUNDLE='9PLCPC32SWLZ',CHILD='9NQ387M27TMV',LASTLIGHT='9NM5W1TDNQZ3',UNRELATED='9ZZZZZZZZZZZ';
const OTHER_BUNDLE='9NT97ZJRV60X',MIDDLE='9MID00000001',CID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const products=fixture.Products as unknown as Record<string,unknown>[];

type Row={productId:string;satisfiedByProductId?:string;status?:string;isTrial?:boolean;sharingSource?:string;endDate?:string;special?:boolean};
const row=(productId:string,patch:Row={}):Row=>({productId,status:'Active',isTrial:false,sharingSource:'None',endDate:new Date(Date.now()+10*60_000).toISOString(),special:false,...patch});
function entitlements(account:string,market:string,rows:Row[]){
 return JSON.stringify({schema:1,account,market,checkedAt:new Date().toISOString(),entitlements:rows});
}

/** Real AccountLibrary (cold cache) + real CatalogService over synthetic metadata. */
function harness(rows:Row[],metadata=products){
 const authState={running:false,stored:true,username:'store'};
 const backend={current:{binaryPath:'/backend',capabilities:{library:true,packageSelection:true}},externalDownloadRunning:async()=>false};
 const settings={market:'US'};
 const state={market:'US',requests:[] as string[][],jobs:[] as any[],downloads:[] as any[],runCalls:0,executed:undefined as any,onRequest:undefined as undefined|((count:number)=>void|Promise<void>)};
 const library=new AccountLibrary(async()=>[],async(_binary,market)=>entitlements(authState.username,market,rows));
 library.select(authState.username,'/backend','US');
 const service=new CatalogService((async (url:URL|RequestInfo)=>{
  const batch=new URL(String(url)).searchParams.get('bigIds')!.split(',');
  state.requests.push(batch);
  await state.onRequest?.(state.requests.length);
  return new Response(JSON.stringify({Products:metadata.filter(product=>batch.includes(product.ProductId as string))}));
 }) as typeof fetch);
 const store={settings:{market:'US',runtimeRoot:'/synthetic/runtime'},games:[],downloads:state.downloads,
  addDownload:async(task:any)=>{state.downloads.push(task);},updateDownload:async()=>{},removeDownload:async()=>{}};
 const handlers=new Map<string,Function>();
 const context:any={authState,backend,store,currentMarket:()=>state.market,accountLibrary:library,catalog:service,
  requestedProductIds,scopedStoreAccess,bundleMembership,bundleHints,assertStoreOfferAccess,assertStoreBundleAccess,
  publicStoreMarket,catalogDetailMarket,gameDetailsTarget,
  stopGameUpdateCheck:async()=>{},ensureIdle(){},preparingInstall:false,prepareSystemWallet:async()=>{},gameOperation:undefined,
  requireBackend:()=>backend.current.binaryPath,safeProductId:(value:string)=>value,
  installPlans:{get:async()=>({status:'ready',choices:[{supported:true,contentId:CID,productId:CHILD,kind:'Game'}]})},installSelection,contentParentForChoice:()=>undefined,
  assertInstallDestination:async(value:string)=>value,path,app:{getPath:()=>'/synthetic/user'},randomUUID:()=> 'synthetic-task',
  downloadCleanup:{inheritResume:async()=>{},prepare:async()=>{}},enrichDownloadCovers:async()=>{},installQueue:{enqueue:(job:any)=>state.jobs.push(job)},
  emitSnapshot(){},shutdownStarted:false,runDownload:async(task:any,binary:string,market:string)=>{state.runCalls++;state.executed={account:authState.username,binary,market,taskProduct:task.productId,selectedContentId:task.selectedContentId};},
  structuredClone,ipcMain:{handle:(name:string,fn:Function)=>handlers.set(name,fn)}};
 runInNewContext(code,context);
 return {state,library,service,context,entry:context.entry as {storeAccess:(ids?:unknown)=>Promise<any>;verifyStoreInstall:(id:string)=>Promise<void>;startInstall:(request:any)=>Promise<string>}};
}
const outcome=async(fn:()=>Promise<unknown>)=>{try{return {accepted:true,value:await fn()};}catch(error){return {accepted:false,error:(error as Error).message};}};
const nested=()=>{
 const data=structuredClone(products) as any[];
 const root=data.find(product=>product.ProductId===BUNDLE);
 root.DisplaySkuAvailabilities[0].Sku.Properties.BundledSkus=[{BigId:MIDDLE}];
 const middle=structuredClone(root);middle.ProductId=MIDDLE;middle.DisplaySkuAvailabilities[0].Sku.Properties.BundledSkus=[{BigId:CHILD}];
 data.push(middle);
 return data;
};

it('offers verification for an exact Metro child of the owned bundle from a COLD account cache',async()=>{
 const h=harness([row(BUNDLE)]);
 const scoped=await h.entry.storeAccess([CHILD,UNRELATED]);
 // The owned root comes from the fresh snapshot, so the hint resolves it on the first read.
 expect(h.state.requests.flat()).toContain(BUNDLE);
 expect(scoped.bundleMembershipByProductId).toEqual({[CHILD]:{bundleProductId:BUNDLE,access:'owned'}});
 expect(scoped.accessByProductId).toEqual({[BUNDLE]:'owned'});
 // The reverse hint for a second, unowned bundle is never fetched.
 expect(h.state.requests.flat()).not.toContain(OTHER_BUNDLE);
 // The unscoped read is unchanged and never fetches bundle metadata.
 h.state.requests.length=0;
 const plain=await h.entry.storeAccess();
 expect(plain.bundleMembershipByProductId).toBeUndefined();
 expect(plain.accessByProductId).toEqual({[BUNDLE]:'owned'});
 expect(h.state.requests).toHaveLength(0);
});

it('keeps direct owned install working with 33 and 790 ordinary rights and no bundle graph',async()=>{
 for(const size of [33,790]){
  const ids=Array.from({length:size},(_,i)=>`9${i.toString(36).toUpperCase().padStart(11,'0')}`);
  const h=harness(ids.map(id=>row(id)));
  const result=await outcome(()=>h.entry.verifyStoreInstall(ids[0]));
  expect(result.accepted,`${size} rights`).toBe(true);
  // Exact direct access needs no public metadata at all.
  expect(h.state.requests).toEqual([]);
 }
});

it('denies a Game Pass source for the new path while direct Game Pass keeps its own Install',async()=>{
 // A subscription plan row for the root is Game Pass access, not ownership.
 const h=harness([row(BUNDLE,{satisfiedByProductId:'CFQ7TTC0KGQ8'})]);
 const library=h.library;
 library.select('store','/backend','US');
 const access=await library.storeAccess('US',async(snapshot,wanted)=>scopedStoreAccess(snapshot,wanted,(scope,market)=>h.service.bundleScope(scope,Object.keys(snapshot.accessByProductId).filter(id=>snapshot.accessByProductId[id]==='owned'),market)),[CHILD]);
 expect(access.accessByProductId[BUNDLE]).toBe('gamepass');
 expect(access.bundleMembershipByProductId).toBeUndefined();
 // Direct Game Pass access to the exact product is still a normal Install.
 expect(assertStoreOfferAccess({...access,accessByProductId:{...access.accessByProductId,[LASTLIGHT]:'gamepass'}},LASTLIGHT,{account:'store',backend:'/backend',market:'US'})).toBeUndefined();
});

it('refuses stale membership when the account, backend, market or snapshot changes during the graph',async()=>{
 const mutations:[string,()=>void][] = [
  ['account B',()=>{h.context.authState.username='B';h.library.select('B','/backend','US');}],
  ['account A-B-A',()=>{h.context.authState.username='B';h.library.select('B','/backend','US');h.context.authState.username='store';h.library.select('store','/backend','US');}],
  ['backend',()=>{h.context.backend.current.binaryPath='/other';h.library.select('store','/other','US');}],
  ['market',()=>{h.state.market='CZ';h.context.store.settings.market='CZ';h.library.select('store','/backend','CZ');}],
  ['reset',()=>{h.library.reset();}],
 ];
 for(const [name,mutate] of mutations){
  var h = harness([row(BUNDLE)]);
  h.state.onRequest=()=>{mutate();};
  const result=await outcome(()=>h.entry.verifyStoreInstall(CHILD));
  expect(result.accepted,name).toBe(false);
 }
});

it('refuses membership whose access lease expires during the graph',async()=>{
 const h=harness([row(BUNDLE)]);
 const original=Date.now;
 h.state.onRequest=()=>{vi.setSystemTime(original()+6*60_000);};
 vi.useFakeTimers({now:original()});
 try{await expect(h.entry.storeAccess([CHILD])).rejects.toThrow('Store access expired or the account changed. Refresh account access.');}
 finally{vi.useRealTimers();}
});

it('does not let a queued install run under another account after its proof',async()=>{
 const h=harness([row(BUNDLE)]);
 // The queued closure verifies again; the account switches during that graph.
 // The account switches after the queued install is admitted, during the
 // queue-time proof. The queued closure must recheck its captured identity.
 let requests=0;
 await h.entry.startInstall({source:'store',productId:CHILD,title:'Metro',destination:'/synthetic/metro',selectedContentId:CID,selectionMarket:'US'});
 expect(h.state.jobs).toHaveLength(1);
 h.state.onRequest=()=>{requests++;h.context.authState.username='B';h.library.select('B','/backend','US');};
 await expect(h.state.jobs[0].run()).rejects.toThrow();
 expect(h.state.runCalls).toBe(0);
 expect(requests).toBeGreaterThan(0);
});

it('accepts a nested owned wrapper path and keeps the wrapper out of the install',async()=>{
 const h=harness([row(BUNDLE)],nested());
 const scoped=await h.entry.storeAccess([CHILD]);
 expect(scoped.bundleMembershipByProductId).toEqual({[CHILD]:{bundleProductId:BUNDLE,access:'owned'}});
 // The intermediate wrapper is fetched for validation but never offered.
 expect(h.state.requests.flat()).toContain(MIDDLE);
 const wrapper=await h.entry.storeAccess([MIDDLE]);
 expect(wrapper.bundleMembershipByProductId).toBeUndefined();
});

it('rejects malformed requested scopes before any catalog request',async()=>{
 const h=harness([row(BUNDLE)]);
 for(const value of ['9PLCPC32SWLZ',[1],['SHORT']])await expect(h.entry.storeAccess(value)).rejects.toThrow('Invalid Store product list.');
 expect(h.state.requests).toHaveLength(0);
});

it('keeps exact owned and Game Pass installation independent of a Display Catalog outage',async()=>{
 for(const kind of ['owned','gamepass'] as const){
  const h=harness([row(CHILD,kind==='gamepass'?{satisfiedByProductId:'CFQ7TTC0KGQ8'}:{})]);
  // The real CatalogService transport fails, as during a public metadata outage.
  h.state.onRequest=()=>{throw Error('Synthetic display catalog outage');};
  const direct=await h.library.storeAccess('US');
  expect(direct.accessByProductId[CHILD]).toBe(kind);
  const result=await outcome(()=>h.entry.verifyStoreInstall(CHILD));
  expect(result.accepted,kind).toBe(true);
  expect(h.state.requests,`${kind} metadata calls`).toHaveLength(0);
 }
});

it('keeps current direct access when a mixed scope loses its fallback metadata',async()=>{
 const h=harness([row(CHILD),row(BUNDLE)]);
 h.state.onRequest=()=>{throw Error('Synthetic display catalog outage');};
 // The mixed read still returns the direct row; the fallback simply has no proof.
 const scoped=await h.entry.storeAccess([CHILD,LASTLIGHT]);
 expect(scoped.accessByProductId[CHILD]).toBe('owned');
 expect(scoped.bundleMembershipByProductId).toBeUndefined();
 // An unowned-only fallback reports the truthful metadata failure.
 await expect(h.entry.storeAccess([LASTLIGHT])).rejects.toThrow('Microsoft Store bundle details could not be loaded');
});

it('offers verification when the owned bundle and its child share one request',async()=>{
 const h=harness([row(BUNDLE)]);
 const scoped=await h.entry.storeAccess([BUNDLE,CHILD,LASTLIGHT]);
 // The requested owned wrapper sources the other requested children.
 expect(scoped.bundleMembershipByProductId).toEqual({[CHILD]:{bundleProductId:BUNDLE,access:'owned'},[LASTLIGHT]:{bundleProductId:BUNDLE,access:'owned'}});
 // It is never its own member and stays out of the ownership map.
 expect(scoped.bundleMembershipByProductId![BUNDLE]).toBeUndefined();
 expect(scoped.accessByProductId).toEqual({[BUNDLE]:'owned'});
 // Unrelated and unowned requests in the same batch stay denied.
 expect(scoped.bundleMembershipByProductId![UNRELATED]).toBeUndefined();
});

it('keeps the bundle wrapper and unrelated products out of the verification map',async()=>{
 const h=harness([row(BUNDLE)]);
 const scoped=await h.entry.storeAccess([BUNDLE,UNRELATED]);
 expect(scoped.bundleMembershipByProductId).toBeUndefined();
 expect(scoped.accessByProductId).toEqual({[BUNDLE]:'owned'});
});
