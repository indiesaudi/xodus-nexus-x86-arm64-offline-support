import {expect,it} from 'vitest';
import {assertStoreBundleAccess,assertStoreOfferAccess} from './catalog-access.js';
const now=Date.parse('2026-11-03T09:00:00Z'),id='9AAAAAAAAAAA';
const context={account:'store',backend:'/backend',market:'US'};
const access={...context,configuredMarket:'US',checkedAt:new Date(now).toISOString(),expiresAt:new Date(now+60_000).toISOString(),accessByProductId:{[id]:'owned' as const}};
it('requires current Store/backend/market and exact owned or Game Pass offer evidence',()=>{
 expect(()=>assertStoreOfferAccess(access,id,context,now)).not.toThrow();
 expect(()=>assertStoreOfferAccess({...access,accessByProductId:{[id]:'gamepass'}},id,context,now)).not.toThrow();
 for(const change of [{account:'player'},{backend:'/other'},{market:'CZ'}])expect(()=>assertStoreOfferAccess(access,id,{...context,...change},now)).toThrow();
 for(const map of [{},{[id]:'other' as const}])expect(()=>assertStoreOfferAccess({...access,accessByProductId:map},id,context,now)).toThrow();
 expect(()=>assertStoreOfferAccess(access,'9BBBBBBBBBBB',context,now)).toThrow();
});
it('rejects expired, malformed and overlong leases independently of branding',()=>{
 for(const expiresAt of ['invalid',new Date(now).toISOString(),new Date(now+6*60_000).toISOString()])expect(()=>assertStoreOfferAccess({...access,expiresAt},id,context,now)).toThrow();
});
const bundle='9PLCPC32SWLZ',child='9NQ387M27TMV';
const member={configuredMarket:'US',account:'store',backend:'/backend',market:'US',checkedAt:new Date(now).toISOString(),expiresAt:new Date(now+60_000).toISOString(),
 accessByProductId:{[bundle]:'owned' as const},bundleMembershipByProductId:{[child]:{bundleProductId:bundle,access:'owned' as const}}};
it('permits an exact owned-bundle child to reach the genuine license check, never as ownership',()=>{
 expect(()=>assertStoreBundleAccess(member,child,context,now)).not.toThrow();
 // Game Pass access to the root is not ownership: the fallback is OWNED-only.
 expect(()=>assertStoreBundleAccess({...member,accessByProductId:{[bundle]:'gamepass'},bundleMembershipByProductId:{[child]:{bundleProductId:bundle,access:'gamepass'}}},child,context,now)).toThrow();
 expect(()=>assertStoreBundleAccess({...member,bundleMembershipByProductId:{[child]:{bundleProductId:bundle,access:'gamepass'}}},child,context,now)).toThrow();
 // Membership never replaces direct evidence: the child is not owned.
 expect(()=>assertStoreOfferAccess(member,child,context,now)).toThrow();
 expect(member.accessByProductId[child]).toBeUndefined();
 // The bundle wrapper itself, an unrelated product and a missing membership are refused.
 for(const id of [bundle,'9BBBBBBBBBBB'])expect(()=>assertStoreBundleAccess(member,id,context,now)).toThrow();
 expect(()=>assertStoreBundleAccess({...member,bundleMembershipByProductId:{}},child,context,now)).toThrow();
 // A membership whose owned source is no longer current is refused.
 for(const accessByProductId of [{},{[bundle]:'other' as const}])
  expect(()=>assertStoreBundleAccess({...member,accessByProductId},child,context,now)).toThrow();
 // A self-referential or malformed membership grants nothing.
 for(const bundleMembershipByProductId of [{},{[child]:{bundleProductId:child,access:'owned' as const}}] as any[])
  expect(()=>assertStoreBundleAccess({...member,bundleMembershipByProductId},child,context,now)).toThrow();
});
it('binds bundle eligibility to the current account, backend, market and a live lease',()=>{
 for(const change of [{account:'player'},{backend:'/other'},{market:'CZ'}])expect(()=>assertStoreBundleAccess(member,child,{...context,...change},now)).toThrow();
 for(const patch of [{expiresAt:'invalid'},{expiresAt:new Date(now).toISOString()},{expiresAt:new Date(now+6*60_000).toISOString()},{checkedAt:new Date(now+120_000).toISOString()}])
  expect(()=>assertStoreBundleAccess({...member,...patch},child,context,now)).toThrow();
 // Expiry after the graph, before the queued install, refuses the stale result.
 expect(()=>assertStoreBundleAccess(member,child,context,now+60_000)).toThrow();
});
it('persists Store provenance across paused download restoration',async()=>{
 const fs=await import('node:fs/promises'),path=await import('node:path'),{StateStore}=await import('./store.js');
 const {tmpdir}=await import('node:os');
 const root=await fs.mkdtemp(path.join(tmpdir(),'store-access-state-'));
 try{
  const store=new StateStore(root);await store.load();await store.addDownload({source:'store',id:'synthetic',title:'Synthetic',productId:id,destination:'/synthetic',status:'queued',progress:null,phase:'queued',log:[],startedAt:new Date().toISOString()});
  const reopened=new StateStore(root);await reopened.load();expect(reopened.downloads[0]).toMatchObject({source:'store',status:'paused'});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
