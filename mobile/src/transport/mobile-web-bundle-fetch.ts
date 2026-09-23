import { sha256 } from '@noble/hashes/sha256'
import {
  mobileWebBundleChunkRead,
  mobileWebBundleManifestRead,
  readMobileWebBundleErrorCode
} from './mobile-web-bundle-operations'
import type {
  MobileWebBundleAssetRead,
  MobileWebBundleManifestRead
} from './mobile-web-bundle-reply-schemas'
import type { RpcClient } from './rpc-client'
import { MobileWebBundleFetchError } from './mobile-web-bundle-fetch-refusal'
import { runRpcOperation } from './rpc-operation'

/** The host refuses the fifth concurrent read on one connection with `mobile_web_bundle_read_limited`,
 *  so the client never offers a fifth. The four are chunk reads across the whole manifest, not one
 *  asset each: paging a large asset alone would put every one of its chunks on the critical path. */
const MAX_CONCURRENT_ASSET_READS = 4

export type MobileWebBundleFetchProgress = {
  readonly completedAssets: number
  readonly totalAssets: number
  readonly receivedBytes: number
  readonly totalBytes: number
}

export type MobileWebBundleFetchResult = {
  readonly manifest: MobileWebBundleManifestRead
  readonly assets: ReadonlyMap<string, Uint8Array>
  readonly totalBytes: number
  readonly elapsedMs: number
}

type AssetReassembly = {
  readonly entry: MobileWebBundleAssetRead
  whole: Uint8Array | null
  receivedBytes: number
  outstandingChunks: number
}

type ChunkRead = { readonly asset: AssetReassembly; readonly offset: number }

/**
 * Reads the manifest, pages every asset, and returns the verified bytes.
 *
 * Nothing is cached and nothing is rendered: this is the Phase A proof that the pipe carries a whole
 * bundle intact. Every asset is checked against the manifest's own sha256 before it is returned, so
 * a truncated or reordered reassembly fails here rather than in a webview much later.
 */
export async function fetchMobileWebBundle(args: {
  client: RpcClient
  signal?: AbortSignal
  onProgress?: (progress: MobileWebBundleFetchProgress) => void
}): Promise<MobileWebBundleFetchResult> {
  const startedAt = Date.now()
  const stopped = new AbortController()
  throwIfStopped(args.signal, stopped.signal)
  const opened = await runRpcOperation(args.client, mobileWebBundleManifestRead, null)
  const manifest = opened.manifest
  const assets = new Map<string, Uint8Array>()
  let receivedBytes = 0

  const readChunk = async (read: ChunkRead): Promise<void> => {
    const chunk = await runRpcOperation(args.client, mobileWebBundleChunkRead, {
      buildId: manifest.buildId,
      path: read.asset.entry.path,
      offset: read.offset
    })
    // A sibling already failed the fetch; this reply is not worth checking or hashing.
    if (stopped.signal.aborted || read.asset.whole === null) {
      return
    }
    assertChunkDescribesAsset(chunk, read.asset.entry, manifest.buildId, read.offset)
    const bytes = decodeBase64(chunk.dataBase64)
    assertChunkFillsItsSlot(read, bytes.byteLength, chunk.eof, opened.chunkBytes)
    const { whole } = read.asset
    const { offset } = read
    whole.set(bytes, offset)
    read.asset.receivedBytes += bytes.byteLength
    read.asset.outstandingChunks -= 1
    if (read.asset.outstandingChunks > 0) {
      return
    }
    assets.set(read.asset.entry.path, verifyReassembledAsset(read.asset, read.asset.whole))
    receivedBytes += read.asset.whole.byteLength
    args.onProgress?.({
      completedAssets: assets.size,
      totalAssets: manifest.assets.length,
      receivedBytes,
      totalBytes: manifest.totalBytes
    })
  }

  await runChunkWindow({
    reads: planChunkReads(manifest.assets, opened.chunkBytes),
    readChunk,
    signal: args.signal,
    stopped
  })
  return { manifest, assets, totalBytes: receivedBytes, elapsedMs: Date.now() - startedAt }
}

/** Largest asset first, so the biggest script's tail is never the last read left in flight. Offsets
 *  are the host's chunk grid, so every read is known up front; `eof` still comes from the reply. */
function planChunkReads(
  entries: readonly MobileWebBundleAssetRead[],
  chunkBytes: number
): ChunkRead[] {
  const largestFirst = [...entries].sort((left, right) => right.byteLength - left.byteLength)
  return largestFirst.flatMap((entry) => {
    const count = Math.max(1, Math.ceil(entry.byteLength / chunkBytes))
    const asset: AssetReassembly = {
      entry,
      whole: null,
      receivedBytes: 0,
      outstandingChunks: count
    }
    return Array.from({ length: count }, (_, index) => ({ asset, offset: index * chunkBytes }))
  })
}

/**
 * Keeps up to four chunk reads in flight over one queue. A `read_limited` refusal means something
 * else holds one of the host's slots: the window narrows once per refusal at the current width and
 * the read is retried; a refusal of a read sent alone is the host's verdict and fails the fetch.
 */
function runChunkWindow(args: {
  reads: ChunkRead[]
  readChunk: (read: ChunkRead) => Promise<void>
  signal?: AbortSignal
  stopped: AbortController
}): Promise<void> {
  const queue = args.reads
  let width = MAX_CONCURRENT_ASSET_READS
  let inFlight = 0
  return new Promise((resolve, reject) => {
    // One failed chunk stops every other read, not just the next: each read it would still send
    // holds one of the host's four slots against the caller's retry.
    const fail = (error: unknown): void => {
      if (!args.stopped.signal.aborted) {
        args.stopped.abort()
        reject(error)
      }
    }
    const pump = (): void => {
      if (args.stopped.signal.aborted) {
        return
      }
      if (queue.length === 0 && inFlight === 0) {
        resolve()
        return
      }
      while (inFlight < width && queue.length > 0) {
        try {
          throwIfStopped(args.signal, args.stopped.signal)
        } catch (error) {
          fail(error)
          return
        }
        const read = queue.shift()!
        // Allocated at the asset's first read, so a fetch that stops early never holds the rest.
        read.asset.whole ??= new Uint8Array(read.asset.entry.byteLength)
        const sentAtWidth = width
        inFlight += 1
        args.readChunk(read).then(
          () => {
            inFlight -= 1
            pump()
          },
          (error: unknown) => {
            inFlight -= 1
            if (
              sentAtWidth > 1 &&
              readMobileWebBundleErrorCode(error) === 'mobile_web_bundle_read_limited'
            ) {
              width = sentAtWidth === width ? width - 1 : width
              queue.unshift(read)
              pump()
              return
            }
            fail(error)
          }
        )
      }
    }
    pump()
  })
}

/** Offsets are planned, so a chunk that falls short without ending the asset would leave a hole. */
function assertChunkFillsItsSlot(
  read: ChunkRead,
  byteLength: number,
  eof: boolean,
  chunkBytes: number
): void {
  const { path, byteLength: declared } = read.asset.entry
  const end = read.offset + byteLength
  if (byteLength > chunkBytes) {
    throw new MobileWebBundleFetchError(
      'chunk-oversize',
      `bundle chunk for ${path} at ${read.offset} is ${byteLength} bytes, over the host's ${chunkBytes}`
    )
  }
  if (end > declared || (!eof && byteLength > 0 && end >= declared)) {
    throw new MobileWebBundleFetchError(
      'asset-overlong',
      `bundle asset ${path} is longer than the manifest declares`
    )
  }
  if (eof && end < declared) {
    throw new MobileWebBundleFetchError(
      'asset-short',
      `bundle asset ${path} ended at ${end} of ${declared} declared bytes`
    )
  }
  if (!eof && byteLength === 0) {
    throw new MobileWebBundleFetchError(
      'asset-no-progress',
      `bundle asset ${path} made no progress at ${read.offset}`
    )
  }
  if (!eof && byteLength < chunkBytes) {
    throw new MobileWebBundleFetchError(
      'asset-short',
      `bundle chunk for ${path} at ${read.offset} carried ${byteLength} of ${chunkBytes} bytes without ending the asset`
    )
  }
}

function verifyReassembledAsset(asset: AssetReassembly, whole: Uint8Array): Uint8Array {
  if (asset.receivedBytes !== whole.byteLength) {
    throw new MobileWebBundleFetchError(
      'asset-short',
      `bundle asset ${asset.entry.path} ended at ${asset.receivedBytes} of ${whole.byteLength} declared bytes`
    )
  }
  const digest = toHex(sha256(whole))
  if (digest !== asset.entry.sha256) {
    throw new MobileWebBundleFetchError(
      'asset-checksum-mismatch',
      `bundle asset ${asset.entry.path} hashed ${digest}, not ${asset.entry.sha256}`
    )
  }
  return whole
}

/**
 * Every chunk reply restates the build, path and offset it answers, and the whole asset's length and
 * hash. Checking all five is what makes a misrouted or stale reply a failure here instead of a
 * corrupt reassembly: a desktop that auto-updates mid-download answers a later chunk from a
 * different build, and nothing else in the reply would say so.
 */
function assertChunkDescribesAsset(
  chunk: {
    buildId: string
    path: string
    offset: number
    assetByteLength: number
    sha256: string
  },
  asset: MobileWebBundleAssetRead,
  buildId: string,
  offset: number
): void {
  if (chunk.buildId !== buildId) {
    throw new MobileWebBundleFetchError(
      'build-changed-mid-fetch',
      `bundle build changed mid-fetch: asked ${buildId}, served ${chunk.buildId}`
    )
  }
  if (chunk.path !== asset.path || chunk.offset !== offset) {
    throw new MobileWebBundleFetchError(
      'chunk-misrouted',
      `bundle chunk answered ${chunk.path} at ${chunk.offset}, not ${asset.path} at ${offset}`
    )
  }
  if (chunk.sha256 !== asset.sha256 || chunk.assetByteLength !== asset.byteLength) {
    throw new MobileWebBundleFetchError(
      'asset-entry-changed',
      `bundle asset ${asset.path} no longer matches the manifest entry`
    )
  }
}

/** The caller's abort is what it asked for; the internal one never leaves this module, because the
 *  read that failed rejects the window before any sibling can. */
function throwIfStopped(caller: AbortSignal | undefined, stopped: AbortSignal): void {
  if (caller?.aborted === true) {
    throw new MobileWebBundleFetchError('fetch-stopped', 'mobile web bundle fetch aborted')
  }
  if (stopped.aborted) {
    throw new MobileWebBundleFetchError(
      'fetch-stopped',
      'mobile web bundle fetch stopped after an earlier chunk failed'
    )
  }
}

/** Metro ships no Buffer; `atob` is the decoder the pairing and E2EE paths already run on Hermes. */
function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
