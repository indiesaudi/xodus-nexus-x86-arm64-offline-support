import type {LibraryAccess, StoreAccess, StoreBundleMember} from '../shared/types.js';
import {excludedStoreOffer} from './catalog.js';

type Product = Record<string, any>;
const object = (value: unknown): Product | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Product : undefined;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Z0-9]{12}$/.test(value);
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const MAX_REQUESTED = 32, MAX_ROOTS = 32, MAX_CHILDREN = 64, MAX_DEPTH = 6;
// The new fallback path is OWNED-only. Direct Game Pass access keeps its own
// normal Install; subscription access to a bundle is not ownership of it.
const owned = (value: LibraryAccess | undefined): boolean => value === 'owned';

/** A full (non-trial, non-preorder) SKU that bundles at least one product. */
export function bundleRoot(product: Product | undefined): boolean {
  return list(product?.DisplaySkuAvailabilities).some(row => {
    const sku = object(object(row)?.Sku), properties = object(sku?.Properties);
    if (!properties || properties.IsTrial !== false || properties.IsPreOrder === true) return false;
    if (['trial', 'demo'].includes(String(sku?.SkuType ?? '').toLowerCase())) return false;
    return list(properties.BundledSkus).some(entry => id(object(entry)?.BigId));
  });
}

function bundleChildren(product: Product | undefined): string[] {
  const children = new Set<string>();
  for (const row of list(product?.DisplaySkuAvailabilities)) {
    const sku = object(object(row)?.Sku), properties = object(sku?.Properties);
    if (!properties || properties.IsTrial !== false || properties.IsPreOrder === true) continue;
    if (['trial', 'demo'].includes(String(sku?.SkuType ?? '').toLowerCase())) continue;
    for (const entry of list(properties.BundledSkus)) {
      const child = object(entry)?.BigId;
      if (id(child)) children.add(child.toUpperCase());
    }
  }
  return [...children];
}

/** Public `Bundle` reverse relations. These only seed which owned products are
 * worth checking; they never grant access on their own. */
export function bundleHints(product: Product | undefined): string[] {
  const hints = new Set<string>();
  for (const market of list(product?.MarketProperties))
    for (const relation of list(object(market)?.RelatedProducts)) {
      const related = object(relation)?.RelatedProductId;
      if (object(relation)?.RelationshipType === 'Bundle' && id(related)) hints.add(related.toUpperCase());
    }
  return [...hints];
}

/** Exactly one full Windows.Desktop MSIXVC package on the game itself. */
function supportedGame(product: Product | undefined): boolean {
  if (!product || product.ProductType !== 'Game') return false;
  const desktop = list(product.DisplaySkuAvailabilities).some(row => {
    const sku = object(object(row)?.Sku), properties = object(sku?.Properties);
    if (!properties || properties.IsTrial !== false || properties.IsPreOrder === true) return false;
    if (['trial', 'demo'].includes(String(sku?.SkuType ?? '').toLowerCase())) return false;
    return list(properties.Packages).some(entry => {
      const pkg = object(entry);
      return pkg?.PackageFormat === 'MSIXVC' && list(pkg.Architectures).includes('x64')
        && list(pkg.PlatformDependencies).some(dependency => object(dependency)?.PlatformName === 'Windows.Desktop');
    });
  });
  return desktop && !excludedStoreOffer({}, product);
}

function details(products: Product[]): Map<string, Product> {
  const map = new Map<string, Product>();
  for (const product of products) {
    const productId = id(product?.ProductId) ? product.ProductId.toUpperCase() : undefined;
    if (productId && !map.has(productId)) map.set(productId, product);
  }
  return map;
}

/**
 * Derive, for the requested Store products only, whether each is an exact
 * supported PC game reachable through a validated forward bundle path from one
 * currently OWNED bundle offer. The bundle itself is never installable and a
 * child is never marked owned: this is eligibility for the genuine Xodus
 * license check that gates every download. `products` must come from the
 * bounded main-process catalog lookup, never from renderer-supplied metadata.
 */
export function bundleMembership(products: Product[], requested: string[], access: Record<string, LibraryAccess>, roots?: string[]): Record<string, StoreBundleMember> {
  const map = details(products);
  const wanted = new Set(requested.map(value => value.toUpperCase()));
  // Only currently owned products can be a source, and only ones the caller
  // selected as relevant candidates (never the whole rights map by default).
  // A requested owned wrapper may source another requested child; only the
  // target itself is excluded, and a requested wrapper never becomes a member.
  const sources = [...new Set((roots ?? Object.keys(access)).map(value => value.toUpperCase()))]
    .filter(root => owned(access[root]) && bundleRoot(map.get(root)))
    .slice(0, MAX_ROOTS);
  const result: Record<string, StoreBundleMember> = {};
  for (const productId of wanted) {
    if (owned(access[productId]) || !supportedGame(map.get(productId))) continue;
    const source = sources.find(root => forwardPath(map, root, productId));
    if (source) result[productId] = {bundleProductId: source, access: 'owned'};
  }
  return result;
}

/** An explicit forward BundledSkus path from the owned root to the requested
 * game. Intermediate nodes must themselves be full bundle offers, every step is
 * bounded, and a cycle or a missing node ends the search without a guess. */
function forwardPath(map: Map<string, Product>, root: string, target: string): boolean {
  const seen = new Set([root]);
  let frontier = [root];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const child of bundleChildren(map.get(node)).slice(0, MAX_CHILDREN)) {
        if (child === target) return true;
        if (seen.has(child) || next.length >= MAX_CHILDREN) continue;
        seen.add(child);
        if (bundleRoot(map.get(child))) next.push(child);
      }
    }
    frontier = next;
  }
  return false;
}

/** The requested IDs a store access read may resolve, bounded and validated. */
export function requestedProductIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_REQUESTED || value.some(entry => !id(entry))) throw Error('Invalid Store product list.');
  return [...new Set((value as string[]).map(entry => entry.toUpperCase()))];
}

/** Store access plus membership for exactly the requested products. */
export async function scopedStoreAccess(access: StoreAccess, requested: string[], resolve: (ids: string[], market: string) => Promise<Record<string, unknown>[]>): Promise<StoreAccess> {
  const wanted = [...new Set(requested.map(entry => entry.toUpperCase()))];
  // Direct owned/Game Pass evidence needs no public metadata at all: never make
  // an existing Store installation depend on the Display Catalog.
  const fallback = wanted.filter(productId => !['owned', 'gamepass'].includes(access.accessByProductId[productId] ?? ''));
  if (!fallback.length) return access;
  let products: Record<string, unknown>[];
  try { products = await resolve(fallback, access.market); }
  catch (error) {
    // A metadata failure must not erase current direct evidence in a mixed
    // scope; an unowned-only fallback reports the truthful failure.
    if (fallback.length < wanted.length) return access;
    throw error;
  }
  const bundleMembershipByProductId = bundleMembership(products, fallback, access.accessByProductId);
  return Object.keys(bundleMembershipByProductId).length ? {...access, bundleMembershipByProductId} : access;
}
