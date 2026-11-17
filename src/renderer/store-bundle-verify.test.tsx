// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {StorePage} from './App';
import {CatalogGameDetails} from './CatalogGameDetails';
import {PackageInstallProvider,confirmedPackageInstall} from './PackageInstall';
import {demoSnapshot} from '../shared/demo-data';
import type {CatalogProduct,CatalogSearchResult} from '../shared/types';
import {storeAccessBatches,storeProductEligible,useStoreAccess,useStoreAccessScopes,type StoreAccessEvidence} from './store-access';
vi.mock('./GameDetails',()=>({GameDetails:({play,notices}:{play:React.ReactNode;notices:React.ReactNode})=><main>{play}{notices}</main>}));

// Sanitized public metadata captured for issue 543: Metro Saga Bundle and its
// PC game children. Only the fields the eligibility rules read are used.
const BUNDLE='9PLCPC32SWLZ',METRO2033='9NQ387M27TMV',LASTLIGHT='9NM5W1TDNQZ3',UNRELATED='9ZZZZZZZZZZZ';
const product=(id:string,title=id):CatalogProduct=>({productId:id,title,description:'',categories:[],installability:'supported',supportNote:'Supported'});
const result=(products:CatalogProduct[]):CatalogSearchResult=>({query:'Top paid games',market:'US',products,cursor:undefined,hasMore:false,fetchedAt:new Date().toISOString(),source:'Microsoft Store'});
const evidence=(data=demoSnapshot(),membership:StoreAccessEvidence['bundleMembershipByProductId']={},ttl=60_000):StoreAccessEvidence=>({
 account:data.auth.username!,backend:data.backend.binaryPath!,market:'US',configuredMarket:data.settings.market,
 checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+ttl).toISOString(),accessByProductId:{[BUNDLE]:'owned'},...(membership?{bundleMembershipByProductId:membership}:{})});
const member={[METRO2033]:{bundleProductId:BUNDLE,access:'owned' as const}};

it('distinguishes direct verified access from bundle verification eligibility',()=>{
 const data=demoSnapshot(),now=Date.now();
 const direct=evidence(data),child=evidence(data,member);
 expect(storeProductEligible(direct,data,product(BUNDLE),now)).toBe('owned');
 expect(storeProductEligible(child,data,product(METRO2033),now)).toBe('verify');
 // A membership without a current OWNED source is not eligibility. Game Pass
 // access to the root is not ownership of that bundle, so it is denied here
 // while direct Game Pass access to the exact product stays a normal Install.
 expect(storeProductEligible({...child,accessByProductId:{}},data,product(METRO2033),now)).toBeUndefined();
 expect(storeProductEligible({...child,accessByProductId:{[BUNDLE]:'other'}},data,product(METRO2033),now)).toBeUndefined();
 expect(storeProductEligible({...child,accessByProductId:{[BUNDLE]:'gamepass'}},data,product(METRO2033),now)).toBeUndefined();
 expect(storeProductEligible({...child,bundleMembershipByProductId:{[METRO2033]:{bundleProductId:BUNDLE,access:'gamepass' as never}}},data,product(METRO2033),now)).toBeUndefined();
 expect(storeProductEligible({...direct,accessByProductId:{[BUNDLE]:'gamepass'}},data,product(BUNDLE),now)).toBe('owned');
 // The bundle wrapper keeps direct evidence and never becomes a verify action.
 expect(storeProductEligible(child,data,product(BUNDLE),now)).toBe('owned');
 expect(storeProductEligible({...child,accessByProductId:{},bundleMembershipByProductId:{[BUNDLE]:{bundleProductId:BUNDLE,access:'owned'}}},data,product(BUNDLE),now)).toBeUndefined();
 // Unrelated products and unsupported offers never verify.
 expect(storeProductEligible(child,data,product(UNRELATED),now)).toBeUndefined();
 expect(storeProductEligible(child,data,{...product(METRO2033),installability:'unsupported'},now)).toBeUndefined();
 // Stale, expired or foreign evidence refuses verification and direct access.
 for(const patch of [{account:'store-B'},{backend:'/other'},{configuredMarket:'CZ'},{checkedAt:'bad'},{expiresAt:new Date(now-1).toISOString()}])
  expect(storeProductEligible({...child,...patch},data,product(METRO2033),now)).toBeUndefined();
});

it('requests the selected product first and never drops later displayed cards',()=>{
 const existing=Array.from({length:24},(_,i)=>product(`9${i.toString(36).toUpperCase().padStart(11,'0')}`));
 const selected=product(METRO2033);
 const batches=storeAccessBatches([...existing,selected],selected);
 // The selected product is in the first bounded batch even as the 25th card.
 expect(batches[0][0].productId).toBe(METRO2033);
 expect(batches[0]).toHaveLength(24);
 // Later displayed cards are not permanently excluded: they continue in a second batch.
 expect(batches.flat().map(entry=>entry.productId)).toContain(existing.at(-1)!.productId);
 expect(new Set(batches.flat().map(entry=>entry.productId)).size).toBe(25);
 expect(batches.every(batch=>batch.length<=24)).toBe(true);
 // Duplicates and invalid IDs are ignored without widening the scope.
 expect(storeAccessBatches([selected,selected,{...selected,productId:'SHORT'}],selected).flat()).toHaveLength(1);
});

it('keeps held eligibility bound to the live scope through an A to B to A change and unmount',async()=>{
 const A=demoSnapshot(),B={...A,auth:{...A.auth,username:'store-B'}};
 let access!:ReturnType<typeof useStoreAccessScopes>;
 const read=vi.fn(async()=>evidence(A,member));
 window.launcher={getStoreAccess:read} as unknown as Window['launcher'];
 function Fixture({data}:{data:typeof A}){access=useStoreAccessScopes(data,[[product(METRO2033)]]);return null;}
 const host=createRoot(document.createElement('div'));
 try{
  await act(async()=>host.render(<Fixture data={A}/>));
  const held=access.eligible;
  expect(held(product(METRO2033))).toBe(true);
  // The held callback follows the live scope, not the evidence it captured.
  await act(async()=>host.render(<Fixture data={B}/>));
  expect(held(product(METRO2033))).toBe(false);
  expect(access.eligible(product(METRO2033))).toBe(false);
  await act(async()=>host.render(<Fixture data={A}/>));
  expect(held(product(METRO2033))).toBe(false);
  await act(async()=>host.render(<Fixture data={A}/>));
  await vi.waitFor(()=>expect(access.eligible(product(METRO2033))).toBe(true));
  const live=access.eligible;
  await act(async()=>host.unmount());
  expect(live(product(METRO2033))).toBe(false);
 }finally{await act(async()=>host.unmount());}
});

it('cancels a held package confirmation when the owning Store scope unmounts',async()=>{
 const data=demoSnapshot();
 let access!:ReturnType<typeof useStoreAccessScopes>;
 window.launcher={getStoreAccess:vi.fn(async()=>evidence(data,member))} as unknown as Window['launcher'];
 function Fixture(){access=useStoreAccessScopes(data,[[product(METRO2033)]]);return null;}
 const host=createRoot(document.createElement('div'));
 await act(async()=>host.render(<Fixture/>));
 await vi.waitFor(()=>expect(access.eligible(product(METRO2033))).toBe(true));
 const held=access.eligible;
 let choose!:(id:string)=>void;
 const confirm=vi.fn(()=>new Promise<string>(resolve=>choose=resolve));
 const api={getInstallPlan:vi.fn(async()=>({status:'ready',market:'US'} as never)),startInstall:vi.fn(async()=> 'queued')};
 const pending=confirmedPackageInstall({productId:METRO2033,title:'Metro',destination:'/synthetic/metro',source:'store'},api,confirm,()=>true,()=>held(product(METRO2033)));
 await vi.waitFor(()=>expect(confirm).toHaveBeenCalled());
 await act(async()=>host.unmount());
 choose('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
 await pending;
 expect(api.startInstall).not.toHaveBeenCalled();
});

it('keeps each batch under its own lease instead of the latest response',async()=>{
 vi.useFakeTimers();
 try{
  const data=demoSnapshot(),now=Date.now();
  let access!:ReturnType<typeof useStoreAccessScopes>;
  const short=evidence(data,{[METRO2033]:{bundleProductId:BUNDLE,access:'owned'}},100);
  const long=evidence(data,{[LASTLIGHT]:{bundleProductId:BUNDLE,access:'owned'}},10_000);
  // A real snapshot has a bounded lease; keep the test window inside it.
  short.checkedAt=long.checkedAt=new Date(now).toISOString();
  const read=vi.fn(async(ids?:string[])=>ids?.includes(METRO2033)?short:long);
  window.launcher={getStoreAccess:read} as unknown as Window['launcher'];
  function Fixture(){access=useStoreAccessScopes(data,[[product(METRO2033)],[product(LASTLIGHT)]]);return null;}
  const host=createRoot(document.createElement('div'));
  try{
   await act(async()=>host.render(<Fixture/>));
   expect(access.eligible(product(METRO2033))).toBe(true);
   expect(access.eligible(product(LASTLIGHT))).toBe(true);
   // Time crosses the short lease before any UI timer runs.
   vi.setSystemTime(now+101);
   expect(access.eligible(product(METRO2033))).toBe(false);
   expect(access.eligible(product(LASTLIGHT))).toBe(true);
  }finally{await act(async()=>host.unmount());}
 }finally{vi.useRealTimers();}
});

it('refreshes expired Store access instead of clearing it permanently',async()=>{
 vi.useFakeTimers();
 try{
  const data=demoSnapshot();
  let access!:ReturnType<typeof useStoreAccessScopes>;
  let ttl=100;
  const read=vi.fn(async()=>evidence(data,{[METRO2033]:{bundleProductId:BUNDLE,access:'owned'}},ttl));
  window.launcher={getStoreAccess:read} as unknown as Window['launcher'];
  function Fixture(){access=useStoreAccessScopes(data,[[product(METRO2033)]]);return null;}
  const host=createRoot(document.createElement('div'));
  try{
   await act(async()=>host.render(<Fixture/>));
   expect(access.eligible(product(METRO2033))).toBe(true);
   // Time crosses the lease before any timer runs: no stale eligibility.
   vi.setSystemTime(Date.now()+101);
   expect(access.eligible(product(METRO2033))).toBe(false);
   expect(read).toHaveBeenCalledTimes(1);
   // The lease timer then refreshes instead of clearing Store access for good.
   ttl=60_000;
   await act(async()=>{await vi.advanceTimersByTimeAsync(100);});
   expect(read.mock.calls.length).toBe(2);
   expect(access.eligible(product(METRO2033))).toBe(true);
  }finally{await act(async()=>host.unmount());}
 }finally{vi.useRealTimers();}
});

it.each([false,true])('uses the requested game batch instead of another full rights map (child first: %s)',async childFirst=>{
 const data=demoSnapshot();
 let access!:ReturnType<typeof useStoreAccessScopes>;
 const base:StoreAccessEvidence={...evidence(data),accessByProductId:{[BUNDLE]:'owned',[METRO2033]:'other',[LASTLIGHT]:'owned'}};
 const child={...base,bundleMembershipByProductId:member};
 window.launcher={getStoreAccess:vi.fn(async(ids?:string[])=>ids?.includes(METRO2033)?child:base)} as unknown as Window['launcher'];
 const batches=childFirst?[[product(METRO2033)],[product(LASTLIGHT)]]:[[product(LASTLIGHT)],[product(METRO2033)]];
 function Fixture(){access=useStoreAccessScopes(data,batches);return null;}
 const host=createRoot(document.createElement('div'));
 try{
  await act(async()=>host.render(<Fixture/>));
  expect(access.eligibility(product(METRO2033))).toBe('verify');
  expect(access.canInstall(product(METRO2033))).toBe(false);
  expect(access.eligibility(product(LASTLIGHT))).toBe('owned');
  expect(base.accessByProductId[METRO2033]).toBe('other');
 }finally{await act(async()=>host.unmount());}
});

it('does not borrow bundle membership from a response for another requested batch',async()=>{
 const data=demoSnapshot();
 let access!:ReturnType<typeof useStoreAccessScopes>;
 const base:StoreAccessEvidence={...evidence(data),accessByProductId:{[BUNDLE]:'owned',[METRO2033]:'other',[LASTLIGHT]:'owned'}};
 const other={...base,bundleMembershipByProductId:member};
 window.launcher={getStoreAccess:vi.fn(async(ids?:string[])=>ids?.includes(METRO2033)?base:other)} as unknown as Window['launcher'];
 function Fixture(){access=useStoreAccessScopes(data,[[product(LASTLIGHT)],[product(METRO2033)]]);return null;}
 const host=createRoot(document.createElement('div'));
 try{
  await act(async()=>host.render(<Fixture/>));
  expect(access.eligibility(product(METRO2033))).toBeUndefined();
  expect(access.eligible(product(METRO2033))).toBe(false);
  expect(access.eligibility(product(LASTLIGHT))).toBe('owned');
 }finally{await act(async()=>host.unmount());}
});

it('reads each bounded batch and ignores a stale batch answer after the scope changed',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const data=demoSnapshot();
 const pending:((value:StoreAccessEvidence)=>void)[]=[];
 const read=vi.fn((_ids?:string[])=>new Promise<StoreAccessEvidence>(done=>pending.push(done)));
 window.launcher={getStoreAccess:read} as unknown as Window['launcher'];
 const existing=Array.from({length:24},(_,i)=>product(`9${i.toString(36).toUpperCase().padStart(11,'0')}`));
 let access!:ReturnType<typeof useStoreAccessScopes>;
 function Fixture({products,selected}:{products:CatalogProduct[];selected?:CatalogProduct}){
  access=useStoreAccessScopes(data,storeAccessBatches(products,selected));return null;
 }
 const host=createRoot(document.createElement('div'));
 try{
  await act(async()=>host.render(<Fixture products={[...existing,product(METRO2033)]} selected={product(METRO2033)}/>));
  // Two bounded batches: the selected product first, then the remaining cards.
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[0][0]).toContain(METRO2033);
  expect(read.mock.calls[0][0]).toHaveLength(24);
  // A batch answer for an older scope must not restore eligibility.
  await act(async()=>host.render(<Fixture products={[product(UNRELATED)]}/>));
  await act(async()=>pending[0](evidence(data,member)));
  expect(access.eligible(product(METRO2033))).toBe(false);
  expect(access.eligibility(product(METRO2033))).toBeUndefined();
 }finally{await act(async()=>host.unmount());}
});

let root:Root;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);});
afterEach(async()=>{await act(async()=>root.unmount());vi.restoreAllMocks();vi.unstubAllGlobals();document.body.innerHTML='';});
const flush=async()=>{await act(async()=>{await Promise.resolve();});await act(async()=>{await Promise.resolve();});};
const button=(label:string)=>[...document.querySelectorAll('button')].find(node=>node.textContent?.includes(label)) as HTMLButtonElement|undefined;
const cardAction=(id:string)=>document.querySelector(`[data-gamepad-detail-target="${id}"]`)?.closest('.catalog-card')?.querySelector<HTMLButtonElement>('.catalog-card-install');

it('offers Verify and install for an owned-bundle child on the Store page and keeps the Store page for unrelated products',async()=>{
 const data=demoSnapshot();
 window.launcher={
  // The first three featured products form the artwork rail; the grid follows.
  getFeaturedCatalog:vi.fn(async()=>result([product('9HERO0000001'),product('9HERO0000002'),product('9HERO0000003'),product(BUNDLE),product(METRO2033),product(LASTLIGHT),product(UNRELATED)])),
  browseCatalog:vi.fn(async()=>result([])),
  getStoreAccess:vi.fn(async(ids?:string[])=>evidence(data,ids?.includes(METRO2033)?{[METRO2033]:{bundleProductId:BUNDLE,access:'owned'}}:{})),
 } as unknown as Window['launcher'];
 await act(async()=>root.render(<StorePage data={data} toast={()=>{}} go={()=>{}} initialQuery=""/>));await flush();
 await vi.waitFor(()=>expect(cardAction(METRO2033)?.textContent).toContain('Verify and install'));
 expect(document.querySelectorAll('.catalog-card')).toHaveLength(4);
 expect(cardAction(LASTLIGHT)?.textContent).toContain('Store page');
 expect(cardAction(UNRELATED)?.textContent).toContain('Store page');
 // The owned bundle wrapper is not installed; its children are chosen instead.
 expect(cardAction(BUNDLE)?.textContent).toContain('Install');
 const requested=vi.mocked(window.launcher.getStoreAccess).mock.calls.at(-1)![0]!;
 expect([...requested].sort()).toEqual(['9HERO0000001','9HERO0000002','9HERO0000003',BUNDLE,METRO2033,LASTLIGHT,UNRELATED].sort());
 // The scope is bounded, never the whole Store catalog.
 expect(requested.length).toBeLessThanOrEqual(24);
});

it('shows the verification wording on the details page and queues the exact selected child',async()=>{
 const data=demoSnapshot();data.games=[];data.downloads=[];
 const startInstall=vi.fn(async()=> 'queued');
 const getInstallPlan=vi.fn(async()=>({status:'ready',market:'US',choices:[{productId:METRO2033,contentId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'METRO 2033 Redux',platform:'Windows.Desktop',packageFormat:'MSIXVC',kind:'Game',supported:true}]}));
 window.launcher={getStoreAccess:vi.fn(async()=>evidence(data,member)),startInstall,getInstallPlan} as unknown as Window['launcher'];
 const details=<PackageInstallProvider><CatalogGameDetails storeMode product={product(METRO2033,'METRO 2033 Redux')} data={data} back={()=>{}} toast={()=>{}}/></PackageInstallProvider>;
 await act(async()=>root.render(details));
 await vi.waitFor(()=>expect(document.querySelector('[data-gamepad-play]')?.textContent).toBe('Verify and install'));
 const play=document.querySelector<HTMLButtonElement>('[data-gamepad-play]')!;
 expect(play.disabled).toBe(false);
 await act(async()=>play.click());
 // The package dialog binds the child content chosen from the offer plan.
 await vi.waitFor(()=>expect(document.querySelector('.package-dialog')).not.toBeNull());
 expect(getInstallPlan).toHaveBeenCalledWith(METRO2033,expect.any(String));
 await act(async()=>document.querySelector<HTMLButtonElement>('.dialog-actions .primary')!.click());
 await vi.waitFor(()=>expect(startInstall).toHaveBeenCalledTimes(1));
 const [request]=startInstall.mock.calls[0] as unknown as [Record<string,unknown>];
 expect(request).toMatchObject({productId:METRO2033,title:'METRO 2033 Redux',source:'store',selectedContentId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',selectionMarket:'US'});
 // The renderer eligibility guard is rechecked after the package choice and
 // after an account scope change; the details-level check is covered by the
 // held-confirmation regression in store-access.test.tsx.
 const other={...data,auth:{...data.auth,username:'store-B'}};
 await act(async()=>root.render(<PackageInstallProvider><CatalogGameDetails storeMode product={product(METRO2033,'METRO 2033 Redux')} data={other} back={()=>{}} toast={()=>{}}/></PackageInstallProvider>));
 await vi.waitFor(()=>expect(document.querySelector('[data-gamepad-play]')).toBeNull());
 // A directly owned product keeps the plain Install action.
 const owned=evidence(data);
 window.launcher={getStoreAccess:vi.fn(async()=>owned)} as unknown as Window['launcher'];
 await act(async()=>root.render(<PackageInstallProvider><CatalogGameDetails storeMode product={product(BUNDLE,'Metro Saga Bundle')} data={demoSnapshot()} back={()=>{}} toast={()=>{}}/></PackageInstallProvider>));
 await vi.waitFor(()=>expect(document.querySelector('[data-gamepad-play]')?.textContent).toBe('Install'));
});

it('stops offering verification when the membership expires or the account changes',async()=>{
 vi.useFakeTimers();
 try{
  const data=demoSnapshot();
  const value={...evidence(data,member),expiresAt:new Date(Date.now()+100).toISOString()};
  const read=vi.fn().mockResolvedValueOnce(value).mockRejectedValue(Error('expired'));
  window.launcher={getStoreAccess:read} as unknown as Window['launcher'];
  await act(async()=>root.render(<CatalogGameDetails storeMode product={product(METRO2033)} data={data} back={()=>{}} toast={()=>{}}/>));
  expect(document.querySelector('[data-gamepad-play]')?.textContent).toBe('Verify and install');
  await act(async()=>vi.advanceTimersByTimeAsync(101));
  expect(document.querySelector('[data-gamepad-play]')).toBeNull();
 }finally{vi.useRealTimers();}
});

it('never restores a held verification result after the account scope changed',async()=>{
 const data=demoSnapshot();
 let resolve!:(value:StoreAccessEvidence)=>void;
 const read=vi.fn(()=>new Promise<StoreAccessEvidence>(done=>resolve=done));
 window.launcher={getStoreAccess:read} as unknown as Window['launcher'];
 let access!:ReturnType<typeof useStoreAccess>;
 function Fixture(){access=useStoreAccess(data,true,[product(METRO2033)]);return null;}
 await act(async()=>root.render(<Fixture/>));
 const guard=access.eligible;
 data.auth={...data.auth,username:'store-B'};
 await act(async()=>root.render(<Fixture/>));
 await act(async()=>resolve(evidence(data,member)));
 expect(guard(product(METRO2033))).toBe(false);
});

it('keeps the selected package binding: the offer is the root task and the chosen child content is sent',async()=>{
 // Existing route preserved: the Store request keeps the offer product ID, the
 // chosen supported package content ID is sent, and eligibility is rechecked.
 const request={productId:BUNDLE,title:'Metro Saga Bundle',destination:'/synthetic/metro',source:'store' as const};
 let eligible=true,resolve!:(value:any)=>void,choose!:(value:string)=>void;
 const api={getInstallPlan:vi.fn(()=>new Promise<any>(done=>resolve=done)),startInstall:vi.fn(async()=> 'queued')};
 const confirm=vi.fn(()=>new Promise<string>(done=>choose=done));
 const pending=confirmedPackageInstall(request,api,confirm,()=>true,()=>eligible);
 resolve({status:'choice',market:'US'});await vi.waitFor(()=>expect(confirm).toHaveBeenCalled());
 choose('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');await pending;
 expect(api.getInstallPlan).toHaveBeenCalledWith(BUNDLE,'/synthetic/metro');
 expect(api.startInstall).toHaveBeenCalledWith({...request,selectedContentId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',selectionMarket:'US'});
 eligible=false;
 const stale=confirmedPackageInstall({...request,productId:METRO2033},api,confirm,()=>true,()=>eligible);
 resolve({status:'choice',market:'US'});await stale;
 expect(api.startInstall).toHaveBeenCalledTimes(1);
});
