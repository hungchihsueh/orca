/**
 * Serves this install's mobile web bundle to the paired client over the already-authenticated RPC
 * connection: one call for the manifest, then one call per 48 KiB chunk of each asset, or one per
 * gzipped range of up to 384 KiB for a client that read `mobileWeb.bundle.range.v1`.
 *
 * No SSH or relay proxying, ever. The bundle is an artifact of the desktop the phone paired with,
 * not something a remote execution host owns, so a runtime answers only out of its own install and
 * never forwards these methods to another host.
 *
 * `asContractError` is a total catch over the verify-and-read block: every host-side failure in
 * there, whatever its cause, reaches the client as `mobile_web_bundle_asset_changed`.
 */
import {
  MOBILE_WEB_BUNDLE_CHUNK_BYTES,
  MOBILE_WEB_BUNDLE_CHUNK_METHOD,
  MOBILE_WEB_BUNDLE_MANIFEST_METHOD,
  MobileWebBundleChunkParamsSchema,
  type MobileWebBundleChunkResult,
  type MobileWebBundleErrorCode,
  type MobileWebBundleManifestResult
} from '../../../../shared/mobile-web-bundle/bundle-rpc-contract'
import {
  MOBILE_WEB_BUNDLE_RANGE_METHOD,
  MobileWebBundleRangeParamsSchema,
  type MobileWebBundleRangeResult
} from '../../../../shared/mobile-web-bundle/bundle-range-rpc-contract'
import type { MobileWebBundleAsset } from '../../../../shared/mobile-web-bundle/manifest-contract'
import {
  loadBundledMobileWebBundle,
  type BundledMobileWebBundle
} from '../../bundled-mobile-web-bundle'
import { isClientDisconnectedError } from '../../orca-runtime-core'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import {
  readMobileWebBundleAssetChunk,
  verifyMobileWebBundleAsset
} from './mobile-web-bundle-asset-reader'
import {
  acquireMobileWebBundleReadSlot,
  mobileWebBundleReadBucket
} from './mobile-web-bundle-read-admission'
import { encodeMobileWebBundleRange } from './mobile-web-bundle-range-encoding'

/** The code IS the message: `InvalidArgumentError` carries no data field, so the message is the only
 *  place a stable code can travel, and a client must be able to branch without matching prose. */
function bundleError(code: MobileWebBundleErrorCode): InvalidArgumentError {
  return new InvalidArgumentError(code)
}

function requireBundle(): BundledMobileWebBundle {
  const bundle = loadBundledMobileWebBundle()
  if (!bundle) {
    throw bundleError('mobile_web_bundle_unavailable')
  }
  return bundle
}

function abortIfDisconnected(ctx: RpcContext): void {
  if (ctx.signal?.aborted) {
    throw new Error('client_disconnected')
  }
}

/** Every other way a read can fail — the asset unlinked, unreadable, or shorter than the manifest
 *  promised — is one thing to a client: this bundle no longer matches the manifest it was handed.
 *  The host path stays on the host; the reply carries only the code. */
function asContractError(error: unknown, path: string): unknown {
  if (error instanceof InvalidArgumentError || isClientDisconnectedError(error)) {
    return error
  }
  console.warn(`[mobile-web-bundle] read failed for ${path}:`, error)
  return bundleError('mobile_web_bundle_asset_changed')
}

/** Exact match against a manifest member. `path` is never joined, normalised, or prefix-matched, so
 *  traversal is not mitigated here — it is unreachable. */
function findAsset(bundle: BundledMobileWebBundle, path: string): MobileWebBundleAsset {
  const asset = bundle.manifest.assets.find((candidate) => candidate.path === path)
  if (!asset) {
    throw bundleError('mobile_web_bundle_asset_unknown')
  }
  return asset
}

/** Alignment is against the window being read: the chunk size the manifest reply advertised, which
 *  the contract deliberately leaves off `offset` so the host can shrink it without a client release,
 *  or a range's own requested length. Offset 0 is always in range, so a zero-byte asset is still
 *  fetchable and still reports eof. */
function assertOffsetAddressesAWindow(
  offset: number,
  windowBytes: number,
  asset: MobileWebBundleAsset
): void {
  if (offset % windowBytes !== 0) {
    throw bundleError('mobile_web_bundle_offset_invalid')
  }
  if (offset > 0 && offset >= asset.byteLength) {
    throw bundleError('mobile_web_bundle_offset_invalid')
  }
}

type VerifiedWindow = { buildId: string; asset: MobileWebBundleAsset; data: Buffer }

/** The checks and the read both methods share, in order: build, member, alignment, read slot,
 *  whole-asset verdict, then the window. `encode` runs inside the slot so a deflate is charged too. */
async function readVerifiedWindow<T>(
  ctx: RpcContext,
  params: { buildId: string; path: string; offset: number },
  windowBytes: number,
  encode: (window: VerifiedWindow) => Promise<T>
): Promise<T> {
  const bundle = requireBundle()
  // Checked before the asset lookup: a desktop that auto-updated mid-download must tell the
  // client to restart from the manifest, not that its path went missing.
  if (params.buildId !== bundle.manifest.buildId) {
    throw bundleError('mobile_web_bundle_build_changed')
  }
  const asset = findAsset(bundle, params.path)
  assertOffsetAddressesAWindow(params.offset, windowBytes, asset)

  const release = acquireMobileWebBundleReadSlot(mobileWebBundleReadBucket(ctx))
  if (!release) {
    throw bundleError('mobile_web_bundle_read_limited')
  }
  try {
    abortIfDisconnected(ctx)
    if (!(await verifyMobileWebBundleAsset(bundle.root, bundle.manifest.buildId, asset))) {
      throw bundleError('mobile_web_bundle_asset_changed')
    }
    abortIfDisconnected(ctx)
    const data = await readMobileWebBundleAssetChunk(bundle.root, asset, params.offset, windowBytes)
    return await encode({ buildId: bundle.manifest.buildId, asset, data })
  } catch (error) {
    throw asContractError(error, asset.path)
  } finally {
    release()
  }
}

export const MOBILE_WEB_BUNDLE_METHODS = [
  defineMethod({
    name: MOBILE_WEB_BUNDLE_MANIFEST_METHOD,
    params: null,
    handler: async (): Promise<MobileWebBundleManifestResult> => ({
      manifest: requireBundle().manifest,
      chunkBytes: MOBILE_WEB_BUNDLE_CHUNK_BYTES
    })
  }),
  defineMethod({
    name: MOBILE_WEB_BUNDLE_CHUNK_METHOD,
    params: MobileWebBundleChunkParamsSchema,
    handler: (params, ctx): Promise<MobileWebBundleChunkResult> =>
      readVerifiedWindow(ctx, params, MOBILE_WEB_BUNDLE_CHUNK_BYTES, async (read) => ({
        buildId: read.buildId,
        path: read.asset.path,
        offset: params.offset,
        // The whole asset's length and hash, so one chunk describes the asset it belongs to.
        assetByteLength: read.asset.byteLength,
        sha256: read.asset.sha256,
        dataBase64: read.data.toString('base64'),
        eof: params.offset + read.data.byteLength >= read.asset.byteLength
      }))
  }),
  defineMethod({
    name: MOBILE_WEB_BUNDLE_RANGE_METHOD,
    params: MobileWebBundleRangeParamsSchema,
    handler: (params, ctx): Promise<MobileWebBundleRangeResult> =>
      readVerifiedWindow(ctx, params, params.length, async (read) => {
        const encoded = await encodeMobileWebBundleRange(read.data)
        return {
          buildId: read.buildId,
          path: read.asset.path,
          offset: params.offset,
          assetByteLength: read.asset.byteLength,
          sha256: read.asset.sha256,
          encoding: encoded.encoding,
          dataBase64: encoded.bytes.toString('base64'),
          eof: params.offset + read.data.byteLength >= read.asset.byteLength
        }
      })
  })
]
