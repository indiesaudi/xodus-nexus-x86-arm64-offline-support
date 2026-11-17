import {expect,it} from 'vitest';
import {bundleHints,bundleMembership,bundleRoot,requestedProductIds,scopedStoreAccess} from './store-bundle-access.js';
import {CatalogService} from './catalog.js';
import fixture from './__fixtures__/metro-bundle.json';

// Sanitized projection of the public Display Catalog metadata captured for
// issue 543: the Metro Saga Bundle, its PC game children and the real public
// RelatedProducts `Bundle` back-references.
const products = fixture.Products as unknown as Record<string, unknown>[];
const BUNDLE='9PLCPC32SWLZ',METRO2033='9NQ387M27TMV',LASTLIGHT='9NM5W1TDNQZ3';
const EXODUS='9P60KL3MHCNH',EXODUS_ENHANCED='9PBW29W139S4',EXODUS_DLC='9NQFNM4489Q0';
const OTHER_BUNDLE='9NT97ZJRV60X',UNRELATED='9ZZZZZZZZZZZ',MIDDLE='9MID00000001';
const clone=()=>structuredClone(products);
const entry=(id:string,list:Record<string,unknown>[])=>list.find(product=>product.ProductId===id)!;
const sku=(product:Record<string,unknown>)=>((product.DisplaySkuAvailabilities as any[])[0].Sku.Properties);

it('permits verification only for exact supported PC game children of an owned bundle',()=>{
 const owned={[BUNDLE]:'owned' as const};
 const members=bundleMembership(clone(),[METRO2033,LASTLIGHT,EXODUS,EXODUS_ENHANCED,EXODUS_DLC,UNRELATED],owned);
 expect(members[METRO2033]).toEqual({bundleProductId:BUNDLE,access:'owned'});
 expect(members[LASTLIGHT]).toEqual({bundleProductId:BUNDLE,access:'owned'});
 expect(members[EXODUS]).toEqual({bundleProductId:BUNDLE,access:'owned'});
 expect(members[EXODUS_ENHANCED]).toEqual({bundleProductId:BUNDLE,access:'owned'});
 // Add-ons and unrelated IDs are never recoverable through bundle membership.
 expect(members[EXODUS_DLC]).toBeUndefined();
 expect(members[UNRELATED]).toBeUndefined();
 // The bundle wrapper itself is not a child and is never offered.
 expect(members[BUNDLE]).toBeUndefined();
 // Only the requested products are described; no global graph is published.
 expect(Object.keys(members).sort()).toEqual([EXODUS_ENHANCED,EXODUS,LASTLIGHT,METRO2033].sort());
});

it('never grants membership without a current OWNED source bundle',()=>{
 for(const access of [{},{[BUNDLE]:'other' as const},{[METRO2033]:'other' as const},{[UNRELATED]:'owned' as const}])
  expect(bundleMembership(clone(),[METRO2033,LASTLIGHT],access)).toEqual({});
 // Game Pass access to the root is not ownership of that bundle: DENY.
 expect(bundleMembership(clone(),[METRO2033],{[BUNDLE]:'gamepass'})).toEqual({});
 expect(bundleMembership(clone(),[METRO2033],{[BUNDLE]:'gamepass',[OTHER_BUNDLE]:'owned'})).toEqual({});
 // A directly owned child keeps its own evidence instead of a verify path.
 expect(bundleMembership(clone(),[METRO2033],{[BUNDLE]:'owned',[METRO2033]:'owned'})).toEqual({});
 // An ordinary `other` row on an unrelated product is never a recovery source.
 expect(bundleMembership(clone(),[METRO2033],{[BUNDLE]:'owned',[UNRELATED]:'other'})[METRO2033]).toEqual({bundleProductId:BUNDLE,access:'owned'});
});

it('denies trial-only, malformed, cyclic, foreign and non-bundle owned sources',()=>{
 const owned={[BUNDLE]:'owned' as const};
 // An owned source whose only SKU is a trial is not a bundle offer.
 const trial=clone();
 sku(entry(BUNDLE,trial)).IsTrial=true;
 expect(bundleMembership(trial,[METRO2033],owned)).toEqual({});
 expect(bundleRoot(entry(BUNDLE,trial))).toBe(false);
 // Malformed child references and missing child metadata grant nothing.
 const malformed=clone();
 sku(entry(BUNDLE,malformed)).BundledSkus=[{BigId:'not-an-id'},{}];
 expect(bundleMembership(malformed,[METRO2033],owned)).toEqual({});
 expect(bundleMembership(clone().filter(product=>product.ProductId!==METRO2033),[METRO2033],owned)).toEqual({});
 // Cyclic metadata terminates, never marks the root as its own child, and the
 // real forward edge still validates.
 const cyclic=clone();
 sku(entry(BUNDLE,cyclic)).BundledSkus=[{BigId:BUNDLE},{BigId:MIDDLE},{BigId:EXODUS}];
 // The game keeps its real child metadata, so the forward edge is explicit.
 sku(entry(EXODUS,cyclic)).BundledSkus=[{BigId:METRO2033}];
 const looped=structuredClone(entry(BUNDLE,cyclic));
 looped.ProductId=MIDDLE;
 sku(looped).BundledSkus=[{BigId:BUNDLE},{BigId:MIDDLE}];
 cyclic.push(looped);
 expect(bundleMembership(cyclic,[METRO2033],owned)).toEqual({[METRO2033]:{bundleProductId:BUNDLE,access:'owned'}});
 // Requested wrappers themselves are never offered as installable children.
 expect(Object.keys(bundleMembership(cyclic,[BUNDLE,MIDDLE],owned))).toEqual([]);
 // A metadata cycle with no forward path to the game grants nothing.
 const dead=structuredClone(cyclic);
 sku(entry(BUNDLE,dead)).BundledSkus=[{BigId:BUNDLE},{BigId:MIDDLE}];
 expect(bundleMembership(dead,[METRO2033],owned)).toEqual({});
 // A source owned only in another market is simply not in this access map.
 expect(bundleMembership(clone(),[METRO2033],{[OTHER_BUNDLE]:'owned'})).toEqual({});
});

it('validates a nested forward path through full intermediate bundles only',()=>{
 const nested=clone();
 sku(entry(BUNDLE,nested)).BundledSkus=[{BigId:MIDDLE}];
 const middle=structuredClone(entry(BUNDLE,nested));
 middle.ProductId=MIDDLE;
 sku(middle).BundledSkus=[{BigId:METRO2033}];
 nested.push(middle);
 // root -> full intermediate bundle -> supported game qualifies.
 expect(bundleMembership(nested,[METRO2033],{[BUNDLE]:'owned'})).toEqual({[METRO2033]:{bundleProductId:BUNDLE,access:'owned'}});
 // An intermediate that is not itself a full bundle offer breaks the path.
 const broken=structuredClone(nested);
 sku(entry(MIDDLE,broken)).BundledSkus=[];
 expect(bundleMembership(broken,[METRO2033],{[BUNDLE]:'owned'})).toEqual({});
 // A cycle through the intermediate terminates without a membership.
 const loop=structuredClone(nested);
 sku(entry(MIDDLE,loop)).BundledSkus=[{BigId:BUNDLE},{BigId:MIDDLE}];
 expect(bundleMembership(loop,[METRO2033],{[BUNDLE]:'owned'})).toEqual({});
 // The intermediate itself is a wrapper, never an installable requested game.
 expect(bundleMembership(nested,[MIDDLE],{[BUNDLE]:'owned'})).toEqual({});
});

it('uses public Bundle relations only as discovery hints, never as a grant',()=>{
 expect(bundleHints(entry(METRO2033,products))).toEqual([BUNDLE,OTHER_BUNDLE]);
 // A hint alone never grants: an owned product named only by a reverse
 // relation, with no forward path to the game, yields no membership.
 expect(bundleMembership(clone(),[METRO2033],{[OTHER_BUNDLE]:'owned'})).toEqual({});
 // A hint cannot turn a Game Pass source into ownership either.
 expect(bundleMembership(clone(),[METRO2033],{[BUNDLE]:'gamepass'})).toEqual({});
 // Reverse relations of the root (Parent) are not treated as bundle hints.
 expect(bundleHints(entry(BUNDLE,products))).toEqual([]);
});

it('rejects malformed requested scopes instead of resolving them',()=>{
 expect(requestedProductIds(undefined)).toEqual([]);
 expect(requestedProductIds([])).toEqual([]);
 expect(requestedProductIds([METRO2033,METRO2033])).toEqual([METRO2033]);
 const malformed:unknown[]=['9PLCPC32SWLZ',[1],Array.from({length:33},(_,i)=>`9${i.toString(36).toUpperCase().padStart(11,'0')}`),['SHORT'],[METRO2033,{}]];
 for(const value of malformed)expect(()=>requestedProductIds(value)).toThrow('Invalid Store product list.');
 // The renderer sends uppercase IDs; lowercase input is rejected, not guessed.
 expect(()=>requestedProductIds([METRO2033.toLowerCase()])).toThrow('Invalid Store product list.');
});

it('resolves only the requested products plus owned roots through the bounded catalog lookup',async()=>{
 const access={configuredMarket:'PL',account:'store',backend:'/backend',market:'PL',checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString(),accessByProductId:{[BUNDLE]:'owned' as const}};
 const calls:string[][]=[];
 const scoped=await scopedStoreAccess(access,[METRO2033],async(ids,market)=>{calls.push([...ids,market]);return clone();});
 expect(calls).toEqual([[METRO2033,'PL']]);
 expect(scoped.bundleMembershipByProductId).toEqual({[METRO2033]:{bundleProductId:BUNDLE,access:'owned'}});
 expect(scoped.accessByProductId).toEqual({[BUNDLE]:'owned'});
 // No membership is published when nothing qualifies, keeping the old shape.
 const empty=await scopedStoreAccess(access,[UNRELATED],async()=>clone());
 expect(empty.bundleMembershipByProductId).toBeUndefined();
});

it('keeps the scoped catalog work proportional to relevant owned candidates',async()=>{
 const roots=Array.from({length:32},(_,i)=>`9R${i.toString(36).toUpperCase().padStart(10,'0')}`);
 const data=roots.map((productId,i)=>({ProductId:productId,DisplaySkuAvailabilities:[{Sku:{Properties:{IsTrial:false,BundledSkus:Array.from({length:47},(_,j)=>({BigId:`9C${(i*47+j).toString(36).toUpperCase().padStart(10,'0')}`}))}}}]}));
 let ids=0,calls=0;
 const service=new CatalogService((async (url:URL|RequestInfo)=>{const batch=new URL(String(url)).searchParams.get('bigIds')!.split(',');calls++;ids+=batch.length;return new Response(JSON.stringify({Products:batch.map(id=>data.find(product=>product.ProductId===id)??{ProductId:id})}));}) as typeof fetch);
 // The requested product has no Bundle hint, so no unrelated owned root is traversed.
 await service.bundleScope([METRO2033],roots,'US');
 expect(ids).toBe(1);
 expect(calls).toBe(1);
});
