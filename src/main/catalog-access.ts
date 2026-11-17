import type {StoreAccess} from '../shared/types.js';

type Context={account?:string;backend?:string;market:string};
/** Current account/backend/market evidence with a live, bounded lease. */
function currentEvidence(access:StoreAccess, context:Context, now:number):boolean {
  const expiry=Date.parse(access.expiresAt), checked=Date.parse(access.checkedAt);
  return access.account===context.account&&access.backend===context.backend&&access.market===context.market
    &&Number.isFinite(expiry)&&Number.isFinite(checked)&&checked<=now+60_000&&expiry>now&&expiry<=checked+5*60_000;
}
/** A Store offer must have current account evidence, never public branding. */
export function assertStoreOfferAccess(access:StoreAccess, productId:string, context:Context, now=Date.now()):void {
  if(!currentEvidence(access,context,now)||!['owned','gamepass'].includes(access.accessByProductId[productId]??'')){
    throw Error('No current verified access to this Store offer. Open its Store page or refresh account access.');
  }
}
/** An exact game child of a currently OWNED bundle may reach the genuine
 * license check. This is eligibility, not ownership: the backend still refuses
 * without a real content license, the bundle itself is never installable, and
 * a Game Pass source is not ownership of that bundle. */
export function assertStoreBundleAccess(access:StoreAccess, productId:string, context:Context, now=Date.now()):void {
  const member=access.bundleMembershipByProductId?.[productId];
  if(!currentEvidence(access,context,now)||!member||member.access!=='owned'
    ||access.accessByProductId[member.bundleProductId]!=='owned'||member.bundleProductId===productId){
    throw Error('No current verified access to this Store game. Open its Store page or refresh account access.');
  }
}
