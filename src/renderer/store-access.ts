import {useEffect,useMemo,useRef,useState} from 'react';
import type {AppSnapshot,CatalogProduct,LibraryAccess,StoreBundleMember} from '../shared/types';

/** Account evidence is separate from public Store metadata and marketing labels. */
export interface StoreAccessEvidence {
 account:string;backend:string;market:string;configuredMarket:string;checkedAt:string;expiresAt:string;
 accessByProductId:Record<string,LibraryAccess>;
 /** Main-process verified bundle membership, only for the requested products. */
 bundleMembershipByProductId?:Record<string,StoreBundleMember>;
}
/** A Store action is either direct verified access or, for one exact game
 * child of a currently owned bundle, eligibility for Xodus's own license check. */
export type StoreInstallEligibility='owned'|'verify';
export type StoreAccessProduct=Pick<CatalogProduct,'productId'|'installability'>;
/** Bounded requested scope for main-process bundle verification. */
const REQUESTED_LIMIT=24;
export function storeAccessScope(data:AppSnapshot):string {
 return JSON.stringify([data.auth.stored,data.auth.username,data.auth.running,data.backend.available,data.backend.binaryPath,data.settings.market]);
}
export function freshStoreAccess(evidence:StoreAccessEvidence|undefined,data:AppSnapshot,now=Date.now()):boolean {
 if(!evidence||data.auth.stored!==true||data.auth.running||!data.auth.username||!data.backend.available)return false;
 const checked=Date.parse(evidence.checkedAt),expires=Date.parse(evidence.expiresAt);
 return evidence.account===data.auth.username&&evidence.backend===data.backend.binaryPath&&evidence.configuredMarket===data.settings.market
  &&Number.isFinite(checked)&&Number.isFinite(expires)&&expires>checked&&checked<=now+60_000&&now<expires&&expires<=checked+5*60_000;
}
/** Direct owned/Game Pass evidence for the exact product. */
export function storeProductLicensed(evidence:StoreAccessEvidence|undefined,data:AppSnapshot,product:StoreAccessProduct,now=Date.now()):boolean {
 if(product.installability!=='supported'||!freshStoreAccess(evidence,data,now))return false;
 const access=evidence!.accessByProductId?.[product.productId.toUpperCase()];
 return access==='owned'||access==='gamepass';
}
/** Bundle membership is only a request to verify. The main process derives it
 * from public metadata and a currently OWNED source; the renderer never
 * supplies proof, and the genuine backend license check still gates download.
 * Direct Game Pass access keeps its own normal Install and never becomes this
 * fallback eligibility. */
export function storeProductEligible(evidence:StoreAccessEvidence|undefined,data:AppSnapshot,product:StoreAccessProduct,now=Date.now()):StoreInstallEligibility|undefined {
 if(product.installability!=='supported'||!freshStoreAccess(evidence,data,now))return;
 const productId=product.productId.toUpperCase();
 if(['owned','gamepass'].includes(evidence!.accessByProductId?.[productId]??''))return 'owned';
 const member=evidence!.bundleMembershipByProductId?.[productId];
 if(!member||member.bundleProductId===productId||member.access!=='owned')return;
 if(evidence!.accessByProductId?.[member.bundleProductId]!=='owned')return;
 return 'verify';
}
function requestedIds(products:StoreAccessProduct[]):string[] {
 const ids=[...new Set(products.map(product=>product.productId.toUpperCase()).filter(value=>/^[A-Z0-9]{12}$/.test(value)))];
 return ids.slice(0,REQUESTED_LIMIT).sort();
}
/** Split a displayed product list into bounded request batches. The selected
 * product is always requested first, so a later card or an explicit selection
 * is never silently dropped; the rest follow in display order. */
export function storeAccessBatches(products:StoreAccessProduct[], selected?:StoreAccessProduct):StoreAccessProduct[][] {
 const seen=new Set<string>(),ordered:StoreAccessProduct[]=[];
 for(const product of [...(selected?[selected]:[]),...products]){
  const value=product.productId.toUpperCase();
  if(!/^[A-Z0-9]{12}$/.test(value)||seen.has(value))continue;
  seen.add(value);ordered.push(product);
 }
 const batches:StoreAccessProduct[][]=[];
 for(let offset=0;offset<ordered.length;offset+=REQUESTED_LIMIT)batches.push(ordered.slice(offset,offset+REQUESTED_LIMIT));
 return batches;
}
export function useStoreAccess(data:AppSnapshot, enabled=true, products:StoreAccessProduct[] = []) {
 const [evidence,setEvidence]=useState<StoreAccessEvidence>();
 const alive=useRef(true);
 const [revision,refresh]=useState(0);
 const scope=storeAccessScope(data),requested=requestedIds(products),requestKey=requested.join(',');
 const current=useRef({data,scope,evidence,epoch:0});
 const epoch=current.current.epoch+(current.current.scope===scope?0:1);current.current={data,scope,evidence,epoch};
 useEffect(()=>{
  let active=true,timer:ReturnType<typeof setTimeout>|undefined;
  setEvidence(undefined);
  if(enabled&&data.auth.stored===true&&!data.auth.running&&data.auth.username&&data.backend.available){
   const api=window.launcher as Window['launcher']&{getStoreAccess?:(ids?:string[])=>Promise<StoreAccessEvidence>};
   void api.getStoreAccess?.(requested.length?requested:undefined).then(value=>{
    if(!active||current.current.scope!==scope||!freshStoreAccess(value,current.current.data))return;
    setEvidence(value);
    timer=setTimeout(()=>{if(active){setEvidence(undefined);refresh(value=>value+1);}},Math.max(1,Date.parse(value.expiresAt)-Date.now()));
   }).catch(()=>{/* Unknown account access has no installation action. */});
  }
  return()=>{active=false;if(timer)clearTimeout(timer);};
  // The requested IDs are a bounded scope; a different set is a new read.
 },[scope,revision,enabled,requestKey]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;current.current.evidence=undefined;current.current.epoch++;};},[]);
 const live=()=>alive.current&&current.current.epoch===epoch&&current.current.scope===scope;
 const canInstall=(product:StoreAccessProduct)=>live()&&storeProductLicensed(current.current.evidence,current.current.data,product);
 const eligibility=(product:StoreAccessProduct)=>live()?storeProductEligible(current.current.evidence,current.current.data,product):undefined;
 const eligible=(product:StoreAccessProduct)=>eligibility(product)!==undefined;
 return {canInstall,eligible,eligibility};
}
/** The requested products of one Store surface, stable between renders. */
export function useStoreAccessProducts(products:StoreAccessProduct[]|undefined):StoreAccessProduct[] {
 const key=requestedIds(products??[]).join(',');
 return useMemo(()=>{const wanted=new Set(key?key.split(','):[]);return (products??[]).filter(product=>wanted.has(product.productId.toUpperCase())).slice(0,REQUESTED_LIMIT);},[key]);
}
/** Store access for a displayed list plus the explicit selection. Every batch
 * keeps its own proof and lease; a slow or failed batch only leaves its own
 * cards without an action, and expiry refreshes the whole scope like the
 * single-scope hook. Held callbacks stay bound to the live scope, the captured
 * request set and the owning surface, so an account change, a different batch
 * set or an unmount invalidates them immediately. */
export function useStoreAccessScopes(data:AppSnapshot, batches:StoreAccessProduct[][], enabled=true) {
 const keys=batches.map(batch=>requestedIds(batch).join(','));
 const key=keys.join('|'),scope=storeAccessScope(data);
 const [reads,setReads]=useState<{key:string;evidence:Record<string,StoreAccessEvidence>}>();
 const [revision,refresh]=useState(0);
 const alive=useRef(true);
 const current=useRef({data,scope,key,epoch:0});
 const epoch=current.current.epoch+(current.current.scope===scope&&current.current.key===key?0:1);
 current.current={data,scope,key,epoch};
 useEffect(()=>{
  let active=true;
  const timers:ReturnType<typeof setTimeout>[]=[];
  setReads(undefined);
  if(!enabled||data.auth.stored!==true||data.auth.running||!data.auth.username||!data.backend.available)return;
  const api=window.launcher as Window['launcher']&{getStoreAccess?:(ids?:string[])=>Promise<StoreAccessEvidence>};
  const ids=keys.filter(Boolean).map(value=>value.split(','));
  // Bounded concurrency: never launch the whole displayed feed at once.
  let next=0;
  const worker=async()=>{
   while(active&&next<ids.length){
    const batch=ids[next++];
    try{
     const value=await api.getStoreAccess?.(batch);
     if(!active||!value||!freshStoreAccess(value,current.current.data))continue;
     setReads(previous=>{
      const known=previous?.key===key?previous.evidence:{};
      return {key,evidence:{...known,[batch.join(',')]:value}};
     });
     timers.push(setTimeout(()=>{if(active)refresh(value=>value+1);},Math.max(1,Date.parse(value.expiresAt)-Date.now())));
    }catch{/* Unknown account access has no installation action for this batch. */}
   }
  };
  void Promise.all(Array.from({length:Math.min(3,ids.length)},worker));
  return()=>{active=false;for(const timer of timers)clearTimeout(timer);};
  // A different batch set, account scope or refresh is a new read.
 },[scope,key,enabled,revision]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;current.current.epoch++;};},[]);
 const live=()=>alive.current&&current.current.epoch===epoch&&current.current.scope===scope&&current.current.key===key;
 const evidenceFor=(product:StoreAccessProduct)=>{
  const productId=product.productId.toUpperCase();
  const batch=keys.find(value=>value.split(',').includes(productId));
  if(!batch||reads?.key!==key)return;
  // Every response includes the full rights map, but membership and its lease
  // belong only to the batch that actually requested this game.
  return reads.evidence[batch];
 };
 const eligibility=(product:StoreAccessProduct)=>live()?storeProductEligible(evidenceFor(product),current.current.data,product):undefined;
 const eligible=(product:StoreAccessProduct)=>eligibility(product)!==undefined;
 const canInstall=(product:StoreAccessProduct)=>live()&&storeProductLicensed(evidenceFor(product),current.current.data,product);
 return {canInstall,eligible,eligibility};
}
