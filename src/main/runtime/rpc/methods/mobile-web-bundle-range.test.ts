import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BUNDLE_RANGE_BYTES,
  MOBILE_WEB_BUNDLE_RANGE_METHOD,
  MobileWebBundleRangeResultSchema,
  type MobileWebBundleRangeResult
} from '../../../../shared/mobile-web-bundle/bundle-range-rpc-contract'
import type { MobileWebBundleAsset } from '../../../../shared/mobile-web-bundle/manifest-contract'
import { resetBundledMobileWebBundleCacheForTests } from '../../bundled-mobile-web-bundle'
import type { RpcResponse } from '../core'
import type { RpcDispatcher } from '../dispatcher'
import { resetMobileWebBundleAssetVerdictsForTests } from './mobile-web-bundle-asset-reader'
import {
  acquireMobileWebBundleReadSlot,
  MAX_CONCURRENT_MOBILE_WEB_BUNDLE_READS,
  resetMobileWebBundleReadAdmissionForTests
} from './mobile-web-bundle-read-admission'
import {
  installMobileWebBundleAppPath,
  mobileWebBundleDispatcher,
  mobileWebBundleFiller,
  sha256Hex,
  writeSyntheticMobileWebBundle,
  type SyntheticAsset,
  type SyntheticMobileWebBundle
} from './mobile-web-bundle.test-fixture'

let scratch: string
let dispatcher: RpcDispatcher

type DispatchOptions = { connectionId?: string; clientId?: string; signal?: AbortSignal }

async function range(params: unknown, options?: DispatchOptions): Promise<RpcResponse> {
  return dispatcher.dispatch(
    { id: 'req-range', authToken: 'tok', method: MOBILE_WEB_BUNDLE_RANGE_METHOD, params },
    options
  )
}

function errorMessage(response: RpcResponse): string | undefined {
  return response.ok ? undefined : response.error.message
}

function errorCode(response: RpcResponse): string | undefined {
  return response.ok ? undefined : response.error.code
}

function body(response: RpcResponse): MobileWebBundleRangeResult {
  if (!response.ok) {
    throw new Error(`range failed: ${response.error.message}`)
  }
  return MobileWebBundleRangeResultSchema.parse(response.result)
}

function decoded(result: MobileWebBundleRangeResult): Buffer {
  const wire = Buffer.from(result.dataBase64, 'base64')
  return result.encoding === 'gzip' ? gunzipSync(wire) : wire
}

// Period-256 filler compresses by two orders of magnitude; random bytes do not compress at all.
const COMPRESSIBLE: SyntheticAsset = (() => {
  const bytes = mobileWebBundleFiller(MOBILE_WEB_BUNDLE_RANGE_BYTES * 2 + 777, 11)
  return { path: `assets/${sha256Hex(bytes)}.js`, bytes, contentType: 'text/javascript' }
})()
const INCOMPRESSIBLE: SyntheticAsset = (() => {
  const bytes = randomBytes(MOBILE_WEB_BUNDLE_RANGE_BYTES + 4096)
  return { path: `assets/${sha256Hex(bytes)}.bin`, bytes, contentType: 'application/octet-stream' }
})()

function assetAt(bundle: SyntheticMobileWebBundle, path: string): MobileWebBundleAsset {
  const asset = bundle.assets.find((candidate) => candidate.path === path)
  if (!asset) {
    throw new Error(`no asset ${path}`)
  }
  return asset
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'orca-mobile-web-bundle-range-'))
  installMobileWebBundleAppPath(scratch)
  resetBundledMobileWebBundleCacheForTests()
  resetMobileWebBundleAssetVerdictsForTests()
  resetMobileWebBundleReadAdmissionForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  dispatcher = mobileWebBundleDispatcher()
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('mobileWeb.bundle.range on an install that carries a bundle', () => {
  let bundle: SyntheticMobileWebBundle

  beforeEach(() => {
    bundle = writeSyntheticMobileWebBundle(join(scratch, 'out', 'mobile-web'), 1, [
      COMPRESSIBLE,
      INCOMPRESSIBLE
    ])
  })

  it('pages every asset back byte for byte in 384 KiB ranges, each reply a strict result', async () => {
    for (const asset of bundle.assets) {
      const pieces: Buffer[] = []
      let calls = 0
      for (let offset = 0; ; offset += MOBILE_WEB_BUNDLE_RANGE_BYTES) {
        const result = body(
          await range({
            buildId: bundle.buildId,
            path: asset.path,
            offset,
            length: MOBILE_WEB_BUNDLE_RANGE_BYTES
          })
        )
        calls++
        expect(result).toMatchObject({
          buildId: bundle.buildId,
          path: asset.path,
          offset,
          assetByteLength: asset.byteLength,
          sha256: asset.sha256
        })
        pieces.push(decoded(result))
        if (result.eof) {
          break
        }
      }
      const whole = Buffer.concat(pieces)
      expect(sha256Hex(whole)).toBe(asset.sha256)
      expect(calls).toBe(Math.max(1, Math.ceil(asset.byteLength / MOBILE_WEB_BUNDLE_RANGE_BYTES)))
    }
  })

  it('gzips a compressible range, and the gzip decodes to exactly that range', async () => {
    const result = body(
      await range({
        buildId: bundle.buildId,
        path: COMPRESSIBLE.path,
        offset: MOBILE_WEB_BUNDLE_RANGE_BYTES,
        length: MOBILE_WEB_BUNDLE_RANGE_BYTES
      })
    )

    expect(result.encoding).toBe('gzip')
    expect(Buffer.from(result.dataBase64, 'base64').byteLength).toBeLessThan(
      MOBILE_WEB_BUNDLE_RANGE_BYTES / 10
    )
    expect(
      decoded(result).equals(
        COMPRESSIBLE.bytes.subarray(
          MOBILE_WEB_BUNDLE_RANGE_BYTES,
          MOBILE_WEB_BUNDLE_RANGE_BYTES * 2
        )
      )
    ).toBe(true)
    expect(result.eof).toBe(false)
  })

  // Gzip framing adds bytes to data that does not compress; identity keeps the frame bound.
  it('sends identity for a range gzip would not shrink', async () => {
    const result = body(
      await range({
        buildId: bundle.buildId,
        path: INCOMPRESSIBLE.path,
        offset: 0,
        length: MOBILE_WEB_BUNDLE_RANGE_BYTES
      })
    )

    expect(result.encoding).toBe('identity')
    expect(
      Buffer.from(result.dataBase64, 'base64').equals(
        INCOMPRESSIBLE.bytes.subarray(0, MOBILE_WEB_BUNDLE_RANGE_BYTES)
      )
    ).toBe(true)
  })

  it('refuses a length over the cap, or zero, at the params schema', async () => {
    for (const length of [MOBILE_WEB_BUNDLE_RANGE_BYTES + 1, 0]) {
      const response = await range({
        buildId: bundle.buildId,
        path: COMPRESSIBLE.path,
        offset: 0,
        length
      })
      expect(errorCode(response)).toBe('invalid_argument')
      expect(errorMessage(response)).not.toMatch(/^mobile_web_bundle_/)
    }
  })

  it('serves a shorter range on its own grid and clamps the last one to the asset', async () => {
    const length = 1000
    const script = assetAt(bundle, COMPRESSIBLE.path)
    const middle = body(
      await range({ buildId: bundle.buildId, path: script.path, offset: 2 * length, length })
    )
    const lastOffset = Math.floor(script.byteLength / length) * length
    const last = body(
      await range({ buildId: bundle.buildId, path: script.path, offset: lastOffset, length })
    )

    expect(decoded(middle).equals(COMPRESSIBLE.bytes.subarray(2000, 3000))).toBe(true)
    expect(middle.eof).toBe(false)
    expect(decoded(last).byteLength).toBe(script.byteLength - lastOffset)
    expect(last.eof).toBe(true)
  })

  it('refuses an offset off the requested length grid, or past the end', async () => {
    const script = assetAt(bundle, COMPRESSIBLE.path)
    const attempts = [
      { offset: 1, length: MOBILE_WEB_BUNDLE_RANGE_BYTES },
      { offset: 49_152, length: MOBILE_WEB_BUNDLE_RANGE_BYTES },
      { offset: 1500, length: 1000 },
      { offset: MOBILE_WEB_BUNDLE_RANGE_BYTES * 3, length: MOBILE_WEB_BUNDLE_RANGE_BYTES }
    ]
    for (const attempt of attempts) {
      const response = await range({ buildId: bundle.buildId, path: script.path, ...attempt })
      expect(errorMessage(response)).toBe('mobile_web_bundle_offset_invalid')
    }
  })

  it('serves a zero-byte asset as one empty identity range at eof', async () => {
    const mark = bundle.assets.find((asset) => asset.byteLength === 0)!

    const result = body(
      await range({ buildId: bundle.buildId, path: mark.path, offset: 0, length: 1 })
    )

    expect(result).toMatchObject({ encoding: 'identity', dataBase64: '', eof: true })
  })

  it('refuses a stale build before looking the path up', async () => {
    const response = await range({
      buildId: '0'.repeat(64),
      path: 'assets/not-a-member.js',
      offset: 0,
      length: 1
    })

    expect(errorMessage(response)).toBe('mobile_web_bundle_build_changed')
  })

  it('refuses a path that is not a manifest member', async () => {
    const response = await range({
      buildId: bundle.buildId,
      path: 'manifest.json',
      offset: 0,
      length: 1
    })

    expect(errorMessage(response)).toBe('mobile_web_bundle_asset_unknown')
  })

  it('refuses an asset whose bytes no longer hash to the manifest', async () => {
    writeFileSync(
      join(bundle.root, COMPRESSIBLE.path),
      mobileWebBundleFiller(COMPRESSIBLE.bytes.byteLength, 99)
    )

    const response = await range({
      buildId: bundle.buildId,
      path: COMPRESSIBLE.path,
      offset: 0,
      length: MOBILE_WEB_BUNDLE_RANGE_BYTES
    })

    expect(errorMessage(response)).toBe('mobile_web_bundle_asset_changed')
  })

  // One budget per connection across both read methods, so a phone mixing them cannot hold eight.
  it('charges the same read slots as chunk reads, and refuses one past the cap', async () => {
    const held = Array.from({ length: MAX_CONCURRENT_MOBILE_WEB_BUNDLE_READS }, () =>
      acquireMobileWebBundleReadSlot('conn-a')
    )
    const params = { buildId: bundle.buildId, path: 'index.html', offset: 0, length: 1 }

    expect(errorMessage(await range(params, { connectionId: 'conn-a' }))).toBe(
      'mobile_web_bundle_read_limited'
    )
    expect((await range(params, { connectionId: 'conn-b' })).ok).toBe(true)
    held[0]!()
    expect((await range(params, { connectionId: 'conn-a' })).ok).toBe(true)
  })
})

describe('mobileWeb.bundle.range on an install with no bundle', () => {
  it('answers unavailable', async () => {
    const response = await range({
      buildId: '0'.repeat(64),
      path: 'index.html',
      offset: 0,
      length: 1
    })

    expect(errorMessage(response)).toBe('mobile_web_bundle_unavailable')
  })
})
