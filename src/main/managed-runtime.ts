import { createReadStream, promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ManagedFamilyStatus, ManagedFamilyInstallResult, ManagedRuntimeOptions } from '../shared/types.js';
import { runtimeFamilies, runtimeFamilyArchSuffix, type RuntimeFamily, type RuntimeFamilyArch } from '../shared/runtime-selection.js';
import { parseManagedFamilyRelease, verifyLocalManagedFamilyCandidate, verifyManagedFamilyCandidate, type VerifiedManagedFamilyRelease } from './runtime-family-release.js';
import { resolveRuntimeFamily, retainRuntimeFamilyBuild, verifyRuntimeFamilyPayload, type RuntimeFamilyReceipt } from './runtime-families.js';
import { materializeRuntimeArchive } from './runtime-family-archive.js';
import { runtimePayloadMatches } from './runtime-payload-identity.js';
import { commitRuntimePointer } from './runtime-pointer-commit.js';
const repositories = {
    nexus: 'domsvoboda/nexus-runtime', 'nexus-cachyos': 'domsvoboda/nexus-runtime-cachyos'
};
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
function familyId(v: unknown): RuntimeFamily {
    if (v !== 'nexus' && v !== 'nexus-cachyos')
        throw Error('Unknown managed runtime family');
    return v;
}
/** The exact payload architecture for this manager's host. It is resolved once
 * for the manager and reused for every selection, install and local import. */
function payloadArch(arch: unknown): RuntimeFamilyArch {
    if (arch === 'x64' || arch === 'arm64')
        return arch;
    // The legacy x64-only upstream snapshot still has its own path; only a
    // managed family install requires a supported payload architecture.
    throw Error('Managed runtimes are not built for ' + String(arch) + ' hosts.');
}
/** The ARM64 managed family is Standard only. CachyOS ARM64 is refused at the
 * manager level too, before any release list or archive is selected. */
function managedArch(id: RuntimeFamily, arch: RuntimeFamilyArch): RuntimeFamilyArch {
    if (arch === 'arm64' && id === 'nexus-cachyos')
        throw Error('ARM64 managed runtime is available for the Standard runtime only');
    return arch;
}
/** The distribution suffix for the selected payload architecture and the
 * family-specific asset prefix used by the local import inventory. */
function familyAssets(id: RuntimeFamily, arch: RuntimeFamilyArch) {
    return { suffix: runtimeFamilyArchSuffix[arch], prefix: id === 'nexus' ? 'nexus-runtime-' : 'nexus-runtime-cachyos-' };
}
/** Skip only coherent, producer-shaped opposite-architecture binaries. Inspect
 * every asset, excluding corresponding-source archives, independent of API order.
 * Missing or malformed binaries stay candidates; contradictory metadata cannot
 * hide the newest host release and silently downgrade it to an older build. */
function releaseArchitecture(item: Record<string, unknown>, id: RuntimeFamily, arch: RuntimeFamilyArch): 'same' | 'opposite' | 'unknown' | 'conflict' {
    const prefix = id === 'nexus' ? 'nexus-runtime-' : 'nexus-runtime-cachyos-';
    const binaryName = new RegExp('^' + prefix + '[0-9][A-Za-z0-9._-]*-g[a-f0-9]{8,40}-(x86_64|aarch64)\\.tar\\.xz$');
    const binaries = new Set<RuntimeFamilyArch>(), evidence = new Set<RuntimeFamilyArch>();
    let ambiguousArchive = false;
    const tag = String(item.tag_name);
    if (/(?:^|[^a-z0-9])(?:x64|x86_64)(?:$|[^a-z0-9])/i.test(tag)) evidence.add('x64');
    if (/(?:^|[^a-z0-9])(?:arm64|aarch64)(?:$|[^a-z0-9])/i.test(tag)) evidence.add('arm64');
    for (const asset of item.assets as unknown[]) {
        if (!object(asset) || typeof asset.name !== 'string' || !asset.name.startsWith(prefix)) continue;
        // A checksum or malformed archive can still contradict a binary's host.
        const hint = /-(x86_64|aarch64)\.[A-Za-z0-9.]+$/i.exec(asset.name);
        if (hint) evidence.add(hint[1].toLowerCase() === 'aarch64' ? 'arm64' : 'x64');
        const match = binaryName.exec(asset.name);
        if (match) {
            const found = match[1] === 'aarch64' ? 'arm64' : 'x64';
            binaries.add(found); evidence.add(found);
        } else if (asset.name.endsWith('.tar.xz') && !asset.name.endsWith('-source.tar.xz')) ambiguousArchive = true;
    }
    if (evidence.size > 1) return 'conflict';
    if (binaries.size === 1 && !ambiguousArchive) return binaries.has(arch) ? 'same' : 'opposite';
    return 'unknown';
}
/** The pristine prefix directory of a verified architecture, used to bind the
 * single inert Z: template-link exception of an archive. */
function launchPrefixFor(arch: RuntimeFamilyArch): 'default_pfx' | 'default_pfx_arm64' {
    return arch === 'arm64' ? 'default_pfx_arm64' : 'default_pfx';
}
function options(v: unknown): ManagedRuntimeOptions {
    if (!object(v) || typeof v.allowCachyos !== 'boolean' || typeof v.allowPrerelease !== 'boolean')
        throw Error('Explicit runtime release options are required');
    return {
        allowCachyos: v.allowCachyos, allowPrerelease: v.allowPrerelease
    };
}
export interface ManagedRuntimeLease {
    root: string;
    release(): void;
}
interface Target {
    root: string;
    release: VerifiedManagedFamilyRelease;
    input: unknown;
    bytes: Buffer;
    policy: ManagedRuntimeOptions;
    /** A verified local build-output archive. Never used for published installs. */
    localArchive?: string;
    /** Set only by importLocal, the trusted local validation entrypoint. */
    local?: boolean;
}
interface Context {
    root: () => string;
    reserve: () => ManagedRuntimeLease;
    versions: () => {
        launcher: string;
        backend: string;
    };
    completed: () => void;
    notify: () => void;
    fetcher?: typeof fetch;
    arch?: string;
}
/** Shared managed components only. Never writes global selection, games or prefixes. */
export class ManagedRuntimeManager {
    private states = new Map<RuntimeFamily, ManagedFamilyStatus>(runtimeFamilies.map(id => [id, {
            id, checking: false, installing: false
        }]));
    private issuedTargets=new WeakMap<VerifiedManagedFamilyRelease,Target>();
    private selectionEpoch = 0;
    private targets = new Map<RuntimeFamily, Target>();
    private epochs = new Map<RuntimeFamily, number>();
    constructor(private context: Context) {
    }
    get revision(): number { return this.selectionEpoch; }
    get current(): ManagedFamilyStatus[] {
        return structuredClone([...this.states.values()]);
    }
    private async installed(id: RuntimeFamily, root: string) {
        const directory = path.join(root, 'variants', id), pointerFile = path.join(directory, 'current.json');
        const stamp = await fs.lstat(pointerFile);
        if (!stamp.isFile() || stamp.size > 65536)
            throw Error('Invalid managed pointer');
        const pointerBytes = await fs.readFile(pointerFile);
        const verified = await resolveRuntimeFamily(root, id, this.context.arch ?? process.arch), pointer = JSON.parse(pointerBytes.toString('utf8'));
        if (pointer.buildId !== verified.buildId || pointer.sourceCommit !== verified.sourceCommit || pointer.manifestSha256 !== verified.manifestSha256)
            throw Error('Managed selection changed while checking');
        let provenance: Record<string, unknown> | undefined;
        if (typeof pointer.candidateSha256 === 'string' && /^[a-f0-9]{64}$/.test(pointer.candidateSha256))
            try {
                const file = path.join(directory, 'provenance', verified.buildId + '.' + pointer.candidateSha256 + '.json');
                const stat = await fs.lstat(file);
                if (!stat.isFile() || stat.size > 65536)
                    throw Error('Invalid release provenance');
                const record = JSON.parse(await fs.readFile(file, 'utf8'));
                if (record.schema === 1 && record.family === id && record.buildId === verified.buildId && record.sourceCommit === verified.sourceCommit && record.manifestSha256 === verified.manifestSha256 && record.candidateSha256 === pointer.candidateSha256 && typeof record.tag === 'string' && typeof record.prerelease === 'boolean')
                    provenance = record;
            }
            catch { /* A legacy verified build is not silently assigned a release channel. */
            }
        if (!(await fs.readFile(pointerFile)).equals(pointerBytes))
            throw Error('Managed selection changed while checking');
        return {
            verified, provenance
        };
    }
    async refresh(): Promise<void> {
        const root = this.context.root(), epoch = this.selectionEpoch;
        await Promise.all(runtimeFamilies.map(async (id) => {
            const state = this.states.get(id)!;
            try {
                const { verified, provenance } = await this.installed(id, root);
                if (root !== this.context.root() || epoch !== this.selectionEpoch)
                    return;
                state.installed = {
                    id: verified.id, label: verified.label, buildId: verified.buildId, sourceCommit: verified.sourceCommit, manifestSha256: verified.manifestSha256,
                    displayWinePath: verified.winePath
                };
                state.version = provenance?.tag as string | undefined;
                state.channel = provenance ? (provenance.prerelease ? 'prerelease' : 'stable') : undefined;
                state.updateAvailable = state.available ? provenance?.candidateSha256 !== state.available.candidateSha256 : undefined;
            }
            catch {
                if (root === this.context.root() && epoch === this.selectionEpoch) {
                    state.installed = undefined;
                    state.version = undefined;
                    state.channel = undefined;
                    state.updateAvailable = state.available ? true : undefined;
                }
            }
        }));
    }
    private async policy(id: RuntimeFamily, root: string, value: unknown): Promise<ManagedRuntimeOptions> {
        const request = options(value);
        try {
            const installed = await this.installed(id, root);
            return {
                allowCachyos: request.allowCachyos || id === 'nexus-cachyos', allowPrerelease: request.allowPrerelease
            };
        }
        catch {
            return request;
        }
    }
    private async response(url: string): Promise<Response> {
        let next = url;
        for (let redirects = 0; redirects < 5; redirects++) {
            const response = await (this.context.fetcher ?? fetch)(next, {
                redirect: 'manual', signal: AbortSignal.timeout(600000), headers: {
                    Accept: 'application/vnd.github+json'
                }
            });
            if (![301, 302, 303, 307, 308].includes(response.status)) {
                if (!response.ok)
                    throw Object.assign(Error('Runtime release download failed: HTTP ' + response.status),{status:response.status});
                return response;
            }
            const location = response.headers.get('location');
            if (!location)
                throw Error('Missing runtime asset redirect');
            const target = new URL(location, next);
            if (target.protocol !== 'https:' || target.username || target.password || target.port || !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname))
                throw Error('Untrusted runtime asset redirect');
            next = target.href;
        }
        throw Error('Too many runtime asset redirects');
    }
    private async bytes(url: string, limit: number, exact?: number): Promise<Buffer> {
        const response = await this.response(url);
        if (!response.body)
            throw Error('Empty runtime metadata response');
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            length += chunk.length;
            if (length > limit)
                throw Error('Runtime metadata exceeds limit');
            chunks.push(Buffer.from(chunk));
        }
        if (exact !== undefined && length !== exact)
            throw Error('Runtime metadata size mismatch');
        return Buffer.concat(chunks);
    }
    async check(selection: unknown, value: unknown, channel?: 'stable'|'prerelease'): Promise<ManagedFamilyStatus> {
        const id = familyId(selection), state = this.states.get(id)!, root = this.context.root(), epoch = (this.epochs.get(id) ?? 0) + 1;
        this.epochs.set(id, epoch);
        state.checking = true;
        state.error = undefined;
        try {
            // Validate the host payload architecture before any network read; an
            // unsupported host or an ARM64 CachyOS request stays unavailable.
            const supported = managedArch(id, payloadArch(this.context.arch ?? process.arch));
            this.context.notify();
            const policy = await this.policy(id, root, value), versions = this.context.versions(), arch = supported;
            const json = JSON.parse((await this.bytes('https://api.github.com/repos/' + repositories[id] + '/releases?per_page=30', 2 * 1024 * 1024)).toString('utf8'));
            if (!Array.isArray(json) || json.length > 100)
                throw Error('Invalid runtime release list');
            // Legacy releases without candidate metadata are not managed-family targets.
            // Only releases of the requested host architecture are candidates; a
            // confidently opposite-architecture release is ignored, so one host's
            // newer tag never blocks the other host. Anything of ambiguous
            // architecture is never filtered away as if it were the other host.
            const candidates = json.filter(item => object(item) && item.draft !== true && (item.prerelease !== true || policy.allowPrerelease) && (channel===undefined||typeof item.prerelease!=='boolean'||item.prerelease===(channel==='prerelease')) && typeof item.tag_name === 'string' && item.tag_name.startsWith(id === 'nexus' ? 'runtime-' : 'runtime-cachyos-') && Array.isArray(item.assets) && item.assets.some(asset => object(asset) && asset.name === 'candidate.json') && releaseArchitecture(item, id, arch) !== 'opposite');
            for (const item of candidates)
                if (typeof item.published_at !== 'string' || !Number.isFinite(Date.parse(item.published_at)))
                    throw Error('Invalid managed runtime publication date');
            candidates.sort((a, b) => Date.parse(String(b.published_at)) - Date.parse(String(a.published_at)));
            if (!candidates.length)
                throw Error('No supported published managed-family release is available for this host architecture');
            // The newest same-architecture release is validated exactly. A malformed
            // trusted-format candidate fails closed; it never falls back to an older
            // build (no silent downgrade).
            if (releaseArchitecture(candidates[0], id, arch) === 'conflict')
                throw Error('Conflicting managed runtime release architecture metadata');
            const selected = {
                input: candidates[0], release: parseManagedFamilyRelease(id, candidates[0], {
                    ...policy, arch, launcherVersion: versions.launcher, backendVersion: versions.backend
                })
            };
            const bytes = await this.bytes(selected.release.assets.candidate.url, 2 * 1024 * 1024, selected.release.assets.candidate.size), release = verifyManagedFamilyCandidate(bytes, selected.release);
            if (root !== this.context.root() || this.epochs.get(id) !== epoch)
                throw Error('Runtime release selection changed while checking');
            const target={root,release,input:selected.input,bytes,policy};
            this.targets.set(id,target);this.issuedTargets.set(release,target);
            state.available = {
                version: release.tag, candidateSha256: release.candidateSha256, sourceCommit: release.commit, archiveName: release.assets.binary.name, requiresBackendVersion: release.requiresBackendVersion, requiresLauncherVersion: release.requiresLauncherVersion
            };
            await this.refresh();
        }
        catch (error) {
            if (this.epochs.get(id) === epoch) {
                this.targets.delete(id);
                state.available = undefined;
                state.updateAvailable = undefined;
                state.error = (error as Error).message;
            }
        }
        finally {
            if (this.epochs.get(id) === epoch) {
                state.checking = false;
                try {
                    this.context.notify();
                }
                catch (error) {
                    state.error = [state.error, 'Updating runtime status failed: ' + (error as Error).message].filter(Boolean).join(' ');
                }
            }
        }
        return structuredClone(state);
    }
    async checkInstalledUpdate(selection: unknown, channel: unknown): Promise<ManagedFamilyStatus> {
      const id = familyId(selection);
      if (channel !== 'stable' && channel !== 'prerelease')
          throw Error('Unknown installed runtime channel');
      const installed = await this.installed(id, this.context.root());
      if (!installed.provenance || installed.provenance.prerelease !== (channel === 'prerelease'))
          throw Error('Installed runtime channel changed or is not recorded');
      return this.check(id, { allowCachyos: id === 'nexus-cachyos', allowPrerelease: channel === 'prerelease' }, channel);
  }
    /** A frozen internal target is provided for later component coordinators. */
    target(selection: unknown): Readonly<VerifiedManagedFamilyRelease> | undefined {
        return this.targets.get(familyId(selection))?.release;
    }
    private async directory(root: string, ...parts: string[]): Promise<string> {
        let next = root;
        await fs.mkdir(root, {
            recursive: true, mode: 0o700
        });
        if (!(await fs.lstat(root)).isDirectory())
            throw Error('Managed runtime root must not be a symlink');
        for (const part of parts) {
            next = path.join(next, part);
            try {
                await fs.mkdir(next, {
                    mode: 0o700
                });
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                    throw error;
            }
            if (!(await fs.lstat(next)).isDirectory())
                throw Error('Managed runtime directory must not be a symlink');
        }
        return next;
    }
    private async immutable(file: string, bytes: Buffer | string): Promise<void> {
        const temporary = path.join(path.dirname(file), '.receipt-' + randomUUID());
        let owned = false;
        try {
            const handle = await fs.open(temporary, 'wx', 0o600);
            owned = true;
            try {
                await handle.writeFile(bytes);
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            try {
                await fs.link(temporary, file);
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                    throw error;
                if (!(await fs.lstat(file)).isFile() || !(await fs.readFile(file)).equals(Buffer.from(bytes)))
                    throw Error('Conflicting managed runtime receipt');
            }
            const directory = await fs.open(path.dirname(file), 'r');
            try {
                await directory.sync();
            }
            finally {
                await directory.close();
            }
        }
        finally {
            if (owned)
                await fs.unlink(temporary).catch(() => {
                });
        }
    }
    private async pointer(directory: string): Promise<Buffer | undefined> {
        const file = path.join(directory, 'current.json');
        try {
            const before = await fs.lstat(file);
            if (!before.isFile() || before.size > 65536)
                throw Error('Invalid managed family pointer');
            const bytes = await fs.readFile(file), after = await fs.lstat(file);
            if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size)
                throw Error('Managed family pointer changed');
            return bytes;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return undefined;
            throw error;
        }
    }
    async legacyInstalledChannel(tag: string, name: string, sourceCommit: string): Promise<'stable' | 'prerelease' | undefined> {
      if (!/^runtime-[A-Za-z0-9._-]+-g[a-f0-9]{8,40}$/.test(tag) || tag.includes('..') || !/^nexus-runtime-[0-9][A-Za-z0-9._-]*-g[a-f0-9]{8,40}$/.test(name))
          return;
      for (const repository of ['domsvoboda/nexus-runtime', 'domsvoboda/xodus-nexus', 'domsvoboda/nexus-launcher']) {
          let metadata: unknown;
          try {
              metadata = JSON.parse((await this.bytes(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, 2 * 1024 * 1024)).toString('utf8'));
          }
          catch (error) {
              if ((error as {
                  status?: number;
              }).status === 404)
                  continue;
              throw error;
          }
          if (!object(metadata) || metadata.tag_name !== tag || metadata.draft !== false || typeof metadata.prerelease !== 'boolean' || !Array.isArray(metadata.assets) || metadata.assets.length > 100 || typeof metadata.published_at !== 'string' || !Number.isFinite(Date.parse(metadata.published_at)))
              continue;
          const assets = metadata.assets;
          const binary = name + '-x86_64.tar.xz', checksum = name + '-x86_64.sha512sum';
          if (![binary, checksum].every(name => { const found = assets.filter(item => object(item) && item.name === name); return found.length === 1 && object(found[0]) && found[0].browser_download_url === `https://github.com/${repository}/releases/download/${tag}/${name}` && typeof found[0].size === 'number' && Number.isSafeInteger(found[0].size) && found[0].size > 0 && found[0].size <= (name === binary ? 8 * 1024 ** 3 : 65536); }))
              continue;
          let commit = metadata.target_commitish;
          if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) {
              const ref = JSON.parse((await this.bytes(`https://api.github.com/repos/${repository}/git/ref/tags/${tag}`, 65536)).toString('utf8'));
              let objectRef: unknown = object(ref) ? ref.object : undefined;
              for (let depth = 0; depth < 4 && object(objectRef) && objectRef.type === 'tag' && typeof objectRef.sha === 'string' && /^[a-f0-9]{40}$/.test(objectRef.sha); depth++) {
                  const annotation = JSON.parse((await this.bytes(`https://api.github.com/repos/${repository}/git/tags/${objectRef.sha}`, 65536)).toString('utf8'));
                  objectRef = object(annotation) ? annotation.object : undefined;
              }
              commit = object(objectRef) && objectRef.type === 'commit' ? objectRef.sha : undefined;
          }
          if (commit === sourceCommit)
              return metadata.prerelease ? 'prerelease' : 'stable';
      }
      return;
  }
    async downloadPreparedRelease(value: unknown, root: string, file: string, policy: ManagedRuntimeOptions): Promise<VerifiedManagedFamilyRelease> {
      if (!object(value))
          throw Error('Unknown prepared runtime release');
      const target = this.issuedTargets.get(value as unknown as VerifiedManagedFamilyRelease);
      if (!target || target.root !== root || this.context.root() !== root)
          throw Error('Runtime release preparation changed');
      const versions = this.context.versions();
      const release = verifyManagedFamilyCandidate(target.bytes, parseManagedFamilyRelease(target.release.family, target.input, { ...options(policy), arch: this.context.arch ?? process.arch, launcherVersion: versions.launcher, backendVersion: versions.backend }));
      await this.archive({ ...target, release }, file);
      return release;
  }
    private async archive(target: Target, file: string): Promise<void> {
        const asset = target.release.assets.binary, record = target.release.files.find(item => item.name === asset.name)!;
        const checksumAsset = target.release.assets.checksum, checksumRecord = target.release.files.find(item => item.name === checksumAsset.name)!, sum = await this.bytes(checksumAsset.url, 65536, checksumAsset.size);
        if (digest(sum) !== checksumRecord.sha256)
            throw Error('Runtime checksum metadata changed');
        const line = sum.toString('utf8').match(/^([a-f0-9]{128})[ \t]+\*?([^\r\n]+)\r?\n?$/);
        if (!line || line[2] !== asset.name)
            throw Error('Runtime checksum does not name the selected archive');
        const response = await this.response(asset.url);
        if (!response.body)
            throw Error('Empty runtime archive');
        const handle = await fs.open(file, 'wx', 0o600), h256 = createHash('sha256'), h512 = createHash('sha512');
        let bytes = 0;
        try {
            for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
                bytes += chunk.length;
                if (bytes > asset.size)
                    throw Error('Runtime archive exceeds selected size');
                h256.update(chunk);
                h512.update(chunk);
                await handle.writeFile(chunk);
            }
        }
        finally {
            await handle.close();
        }
        if (bytes !== asset.size || h256.digest('hex') !== record.sha256 || h512.digest('hex') !== line[1])
            throw Error('Runtime archive checksum mismatch');
    }
    private async hashFile(file: string, algorithm: 'sha256' | 'sha512' = 'sha256'): Promise<string> {
        const hash = createHash(algorithm);
        for await (const chunk of createReadStream(file)) hash.update(chunk);
        return hash.digest('hex');
    }
    /** Import a local runtime build-output directory (candidate.json, binary,
     * corresponding source and checksums). This uses the same candidate,
     * payload and pointer verification as a published install; only the bytes
     * come from an explicit user-selected directory. */
    async importLocal(selection: unknown, directory: unknown, value: unknown): Promise<ManagedFamilyInstallResult> {
        const id = familyId(selection);
        let snapshot: string | undefined;
        try {
            if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw Error('Choose an absolute local runtime build directory.');
            const root = this.context.root(), arch = managedArch(id, payloadArch(this.context.arch ?? process.arch)), { suffix, prefix: assetPrefix } = familyAssets(id, arch);
            const candidateFile = path.join(directory, 'candidate.json');
            const candidateStat = await fs.lstat(candidateFile);
            if (!candidateStat.isFile() || candidateStat.isSymbolicLink() || candidateStat.size <= 0 || candidateStat.size > 2 * 1024 * 1024) throw Error('Runtime candidate.json must be a regular bounded file.');
            const candidateBytes = await fs.readFile(candidateFile);
            let candidate: Record<string, unknown>;
            try { candidate = JSON.parse(candidateBytes.toString('utf8')) as Record<string, unknown>; }
            catch { throw Error('Runtime candidate.json is not valid JSON.'); }
            if (!object(candidate) || candidate.schema !== 1 || candidate.kind !== 'runtime' || candidate.repository !== repositories[id] || candidate.ref !== 'refs/heads/main') throw Error('Runtime candidate.json does not belong to this family and main source.');
            if (typeof candidate.commit !== 'string' || !/^[a-f0-9]{40}$/.test(candidate.commit) || !Array.isArray(candidate.files) || candidate.files.length !== 4) throw Error('Runtime candidate.json has an invalid source or file inventory.');
            const records = candidate.files.map(item => object(item) ? item : undefined);
            if (records.some(item => !item || typeof item.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(item.name) || typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size <= 0 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256))) throw Error('Runtime candidate.json has an invalid file inventory.');
            const names = new Set(records.map(item => String(item!.name)));
            // Only this family's archive for this host architecture counts; an
            // archive built for another architecture is never adopted.
            const archive = new RegExp('^' + assetPrefix + '[0-9][A-Za-z0-9._-]*-g([a-f0-9]{8,40})-' + suffix + '\\.tar\\.xz$');
            const binaries = records.filter(item => archive.test(String(item!.name)));
            if (binaries.length !== 1) throw Error('Runtime candidate.json does not name one exact ' + arch + ' family archive.');
            const binary = binaries[0];
            const binaryName = String(binary!.name), hint = binaryName.match(archive)![1], base = binaryName.slice(0, -('-' + suffix + '.tar.xz').length);
            const expected = [base + '-' + suffix + '.sha512sum', base + '-source.tar.xz', base + '-source.sha512sum'];
            if (!expected.every(name => names.has(name))) throw Error('Runtime candidate.json does not bind the exact archive and checksum asset set.');
            const prefix = id === 'nexus' ? 'runtime-' : 'runtime-cachyos-';
            const tag = prefix + 'local-g' + hint;
            const assets = [
                { name: 'candidate.json', size: candidateBytes.length, browser_download_url: `https://github.com/${repositories[id]}/releases/download/${tag}/candidate.json` },
                ...records.map(item => ({ name: String(item!.name), size: Number(item!.size), browser_download_url: `https://github.com/${repositories[id]}/releases/download/${tag}/${String(item!.name)}` })),
            ];
            const versions = this.context.versions();
            const selected = Object.freeze({
                draft: false, prerelease: false, tag_name: tag, target_commitish: String(candidate.commit),
                published_at: new Date().toISOString(), assets,
            });
            const policy = options(value);
            const release = parseManagedFamilyRelease(id, selected, { ...policy, arch: this.context.arch ?? process.arch, launcherVersion: versions.launcher, backendVersion: versions.backend });
            const verified = verifyLocalManagedFamilyCandidate(candidateBytes, release);
            // Copy the complete local inventory into a private staging snapshot,
            // then verify the exact copied bytes. Hashing the user's original
            // directory before a later copy would leave a TOCTOU window while a
            // builder is still writing its output.
            await fs.mkdir(root, { recursive: true, mode: 0o700 });
            snapshot = await fs.mkdtemp(path.join(root, '.import-'));
            await fs.chmod(snapshot, 0o700);
            const copiedCandidate = path.join(snapshot, 'candidate.json');
            await fs.writeFile(copiedCandidate, candidateBytes, { flag: 'wx', mode: 0o600 });
            if (await this.hashFile(copiedCandidate) !== verified.candidateSha256) throw Error('Copied candidate.json differs from the verified candidate.');
            for (const record of verified.files) {
                const source = path.join(directory, record.name), copied = path.join(snapshot, record.name);
                const sourceStat = await fs.lstat(source);
                if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw Error('Local runtime asset must be a regular non-symlink file: ' + record.name);
                await fs.copyFile(source, copied);
                const stat = await fs.lstat(copied);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.size || await this.hashFile(copied, 'sha256') !== record.sha256) throw Error('Copied local runtime asset changed or failed verification: ' + record.name);
            }
            for (const checksumName of [base + '-' + suffix + '.sha512sum', base + '-source.sha512sum']) {
                const text = await fs.readFile(path.join(snapshot, checksumName), 'utf8');
                const match = /^([a-f0-9]{128})[ \t]+\*?([^\r\n]+)\r?\n?$/.exec(text);
                const asset = checksumName.endsWith('-source.sha512sum') ? base + '-source.tar.xz' : binaryName;
                if (!match || match[2] !== asset) throw Error('Copied local runtime checksum does not name the expected archive.');
                if (await this.hashFile(path.join(snapshot, asset), 'sha512') !== match[1]) throw Error('Copied local runtime archive failed SHA-512 verification.');
            }
            const target: Target = { root, release: verified, input: selected, bytes: candidateBytes, policy, localArchive: path.join(snapshot, binaryName), local: true };
            this.targets.set(id, target);
            this.issuedTargets.set(verified, target);
            return await this.install(id, verified.candidateSha256, value);
        }
        catch (error) {
            return { family: id, success: false, committed: false, durability: 'not-committed', error: (error as Error).message };
        }
        finally {
            if (snapshot) await fs.rm(snapshot, { recursive: true, force: true }).catch(() => undefined);
        }
    }
    async install(selection: unknown, expected: unknown, value: unknown, prepared?:Readonly<VerifiedManagedFamilyRelease>): Promise<ManagedFamilyInstallResult> {
        const id = familyId(selection), state = this.states.get(id)!, lease = this.context.reserve();
        let staging: string | undefined, committed = false, buildId: string | undefined, durability: ManagedFamilyInstallResult['durability'] = 'not-committed';
        this.selectionEpoch++;
        this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
        state.checking = false;
        state.installing = true;
        state.error = undefined;
        let outcome: ManagedFamilyInstallResult = {
            family: id, success: false, committed: false, durability: 'not-committed'
        };
        const completionError = (message: string, error: unknown) => {
            const text = message + ': ' + (error instanceof Error ? error.message : String(error));
            state.error = [state.error, text].filter(Boolean).join(' ');
            state.phase = committed ? 'Runtime installed; confirmation needs attention' : 'Active runtime selection was not changed';
            outcome = {
                ...outcome, success: false, committed, durability, error: state.error
            };
        };
        try {
            const selected = prepared ? this.issuedTargets.get(prepared) : this.targets.get(id);
            if (!selected || selected.release.family !== id || selected.root !== lease.root || typeof expected !== 'string' || selected.release.candidateSha256 !== expected)
                throw Error('Check this runtime release again before installing');
            const policy = await this.policy(id, lease.root, value), versions = this.context.versions();
            const parsed = parseManagedFamilyRelease(id, selected.input, {
                ...policy, arch: this.context.arch ?? process.arch, launcherVersion: versions.launcher, backendVersion: versions.backend
            });
            const release = selected.local ? verifyLocalManagedFamilyCandidate(selected.bytes, parsed) : verifyManagedFamilyCandidate(selected.bytes, parsed);
            const target = {
                ...selected, release
            };
            const directory = await this.directory(lease.root, 'variants', id), releases = await this.directory(lease.root, 'variants', id, 'releases'), receipts = await this.directory(lease.root, 'variants', id, 'receipts'), provenance = await this.directory(lease.root, 'variants', id, 'provenance');
            const before = await this.pointer(directory);
            if (before) {
                let valid = false;
                try {
                    await resolveRuntimeFamily(lease.root, id, this.context.arch ?? process.arch);
                    valid = true;
                }
                catch { /* Preserve invalid old evidence, never bless it into a trusted receipt. */
                }
                if (valid)
                    await retainRuntimeFamilyBuild(lease.root, id, this.context.arch ?? process.arch);
                else {
                    const evidence = await this.directory(lease.root, 'variants', id, 'preserved');
                    await this.immutable(path.join(evidence, digest(before) + '.json'), before);
                }
            }
            staging = await this.directory(lease.root, 'variants', id, '.staging-' + randomUUID());
            const archive = path.join(staging, release.assets.binary.name);
            state.phase = selected.localArchive ? 'Verifying local runtime archive' : 'Downloading and verifying runtime';
            this.context.notify();
            if (selected.localArchive) {
                const record = release.files.find(item => item.name === release.assets.binary.name)!;
                const stat = await fs.lstat(selected.localArchive);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.size || await this.hashFile(selected.localArchive) !== record.sha256) throw Error('The local runtime archive changed after it was selected.');
                await fs.copyFile(selected.localArchive, archive);
                const copied = await fs.lstat(archive);
                if (!copied.isFile() || copied.isSymbolicLink() || copied.size !== record.size || await this.hashFile(archive) !== record.sha256) throw Error('The copied local runtime archive failed final verification.');
            }
            else await this.archive(target, archive);
            const extracted = path.join(staging, 'payload');
            await fs.mkdir(extracted, {
                mode: 0o700
            });
            state.phase = 'Checking runtime files';
            this.context.notify();
            // The archive root directory is the stem without the architecture
            // suffix, e.g. nexus-runtime-11.0-experimental-arm64-g<8>.
            const suffix = runtimeFamilyArchSuffix[release.arch];
            const stem = release.assets.binary.name.slice(0, -'.tar.xz'.length), ending = '-' + suffix;
            if (!stem.endsWith(ending))
                throw Error('Runtime archive name does not carry its architecture suffix');
            const top = stem.slice(0, -ending.length);
            // The template exception is this verified architecture's own prefix.
            const payload = await materializeRuntimeArchive(archive, extracted, top, undefined, launchPrefixFor(release.arch));
            const manifestFile = path.join(payload, 'nexus-family.json');
            if (!(await fs.lstat(manifestFile)).isFile() || (await fs.stat(manifestFile)).size > 4 * 1024 * 1024)
                throw Error('Missing bounded managed-family manifest');
            const bytes = await fs.readFile(manifestFile), manifest = JSON.parse(bytes.toString('utf8'));
            buildId = manifest.buildId;
            const receipt: RuntimeFamilyReceipt = {
                schema: 1, family: id, sourceRepository: repositories[id], buildId: manifest.buildId, manifestSha256: digest(bytes), sourceCommit: release.commit
            };
            const { buildId: ignored, ...identity } = manifest;
            if (digest(JSON.stringify(identity)) !== buildId)
                throw Error('Runtime build identity is not derived from its manifest');
            await verifyRuntimeFamilyPayload(payload, receipt, this.context.arch ?? process.arch);
            const metadata = JSON.parse(await fs.readFile(path.join(payload, 'XODUS_NEXUS_PATCH.json'), 'utf8'));
            if (!isDeepStrictEqual(metadata.sourceGraph, release.sourceGraph) || metadata.requiresBackendVersion !== release.requiresBackendVersion || metadata.requiresLauncherVersion !== release.requiresLauncherVersion)
                throw Error('Runtime payload differs from candidate source graph or requirements');
            const destination = path.join(releases, receipt.buildId);
            let exists = true;
            try {
                await fs.lstat(destination);
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw error;
                exists = false;
            }
            if (exists) {
                if (!await runtimePayloadMatches(payload, destination))
                    throw Error('The existing build differs from this verified release and was preserved. Choose a different release or restore it explicitly.');
            }
            else {
                await fs.rename(payload, destination);
                const parent = await fs.open(releases, 'r');
                try {
                    await parent.sync();
                }
                finally {
                    await parent.close();
                }
            }
            await verifyRuntimeFamilyPayload(destination, receipt, this.context.arch ?? process.arch);
            const canonical = {
                schema: 1, family: id, sourceRepository: repositories[id], buildId: receipt.buildId, manifestSha256: receipt.manifestSha256, sourceCommit: receipt.sourceCommit
            };
            await this.immutable(path.join(receipts, receipt.buildId + '.json'), JSON.stringify(canonical) + '\n');
            const proof = {
                ...canonical, tag: release.tag, prerelease: release.prerelease, candidateSha256: release.candidateSha256, files: release.files,
                ...(release.local ? { local: true, diagnosticOnly: true, promotable: false, ...(release.localBuildId ? { localBuildId: release.localBuildId } : {}) } : {})
            };
            await this.immutable(path.join(provenance, receipt.buildId + '.' + release.candidateSha256 + '.json'), JSON.stringify(proof) + '\n');
            const actual = await this.pointer(directory);
            if (before === undefined ? actual !== undefined : actual === undefined || !actual.equals(before))
                throw Error('Managed runtime selection changed before publication');
            const result = await commitRuntimePointer(directory, {
                ...canonical, releaseTag: release.tag, prerelease: release.prerelease, candidateSha256: release.candidateSha256
            });
            committed = true;
            this.selectionEpoch++;
            durability = result.durability;
            await this.refresh();
            if (state.installed?.buildId !== receipt.buildId || state.installed.manifestSha256 !== receipt.manifestSha256)
                throw Error('Runtime selection was published, but installed files could not be verified afterward');
            if (result.errors.length)
                throw new AggregateError(result.errors, 'Runtime installed, but confirming its saved selection failed: ' + result.errors.map(error => error.message).join(' '));
            state.phase = 'Runtime installed';
            outcome = {
                family: id, success: true, committed: true, buildId, durability
            };
        }
        catch (error) {
            state.error = (error as Error).message;
            state.phase = committed ? 'Runtime installed; confirmation needs attention' : 'Active runtime selection was not changed';
            outcome = {
                family: id, success: false, committed, buildId, durability, error: state.error
            };
        }
        finally {
            if (staging)
                await fs.rm(staging, {
                    recursive: true, force: true
                }).catch(error => completionError('Cleaning runtime staging failed', error));
            state.installing = false;
            try {
                this.context.completed();
            }
            catch (error) {
                completionError('Updating runtime readiness failed', error);
            }
            finally {
                try {
                    lease.release();
                }
                catch (error) {
                    completionError('Releasing runtime reservation failed', error);
                }
                finally {
                    try {
                        this.context.notify();
                    }
                    catch (error) {
                        completionError('Updating runtime status failed', error);
                    }
                }
            }
        }
        return outcome;
    }
}
