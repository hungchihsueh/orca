import { sha256 } from '@noble/hashes/sha256'
import { gzipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_BUNDLE_CHUNK_BYTES } from '../../../src/shared/mobile-web-bundle/bundle-rpc-contract'
import { MOBILE_WEB_BUNDLE_RANGE_BYTES } from '../../../src/shared/mobile-web-bundle/bundle-range-rpc-contract'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { fetchMobileWebBundle } from './mobile-web-bundle-fetch'
import { MobileWebBundleFetchError } from './mobile-web-bundle-fetch-refusal'
import type { MobileWebBundleReadMethod } from './mobile-web-bundle-read-method'
import type { RpcClient } from './rpc-client'
import type { RpcResponse } from './types'

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

/** Script-like: repetitive enough to gzip well, varied enough that a misplaced window shows. */
function scriptBytes(byteLength: number, seed: number): Uint8Array {
  return Uint8Array.from({ length: byteLength }, (_, index) =>
    index % 97 === 0 ? (seed + index / 97) % 256 : 97 + ((index * 7 + seed) % 26)
  )
}

type HostCall = { method: string; params: Record<string, unknown> }

/**
 * A host that serves both read methods by the real one's rules: ranges on the caller's own grid,
 * gzipped at level 6 when that shrinks them. `tamper` replaces the body of one range reply.
 */
function rangeHost(
  files: Record<string, Uint8Array>,
  options: { tamper?: (call: HostCall, body: string) => string } = {}
) {
  const assets = Object.entries(files)
    .map(([path, content]) => ({
      path,
      sha256: toHex(sha256(content)),
      byteLength: content.byteLength,
      contentType: 'text/javascript'
    }))
    .sort((left, right) => (left.path < right.path ? -1 : 1))
  const buildId = computeMobileWebBundleId(assets)
  const manifest = {
    schemaVersion: 1,
    buildId,
    desktopVersion: '1.4.200',
    minCompatibleRuntimeProtocolVersion: 2,
    runtimeProtocolVersion: 2,
    entrypoint: assets[0]!.path,
    totalBytes: assets.reduce((total, entry) => total + entry.byteLength, 0),
    assets
  }
  const calls: HostCall[] = []
  let wireBase64Bytes = 0
  let inFlight = 0
  let peakInFlight = 0

  const answer = (call: HostCall): unknown => {
    if (call.method === 'mobileWeb.bundle.manifest') {
      return { manifest, chunkBytes: MOBILE_WEB_BUNDLE_CHUNK_BYTES }
    }
    const path = String(call.params.path)
    const offset = Number(call.params.offset)
    const content = files[path]!
    const length =
      call.method === 'mobileWeb.bundle.range'
        ? Number(call.params.length)
        : MOBILE_WEB_BUNDLE_CHUNK_BYTES
    const slice = content.subarray(offset, offset + length)
    const common = {
      buildId,
      path,
      offset,
      assetByteLength: content.byteLength,
      sha256: toHex(sha256(content)),
      eof: offset + slice.byteLength >= content.byteLength
    }
    if (call.method === 'mobileWeb.bundle.chunk') {
      return { ...common, dataBase64: encodeBase64(slice) }
    }
    const gzipped = gzipSync(slice, { level: 6 })
    const encoding = gzipped.byteLength < slice.byteLength ? 'gzip' : 'identity'
    const body = encodeBase64(encoding === 'gzip' ? gzipped : slice)
    return { ...common, encoding, dataBase64: options.tamper?.(call, body) ?? body }
  }

  const client: RpcClient = {
    sendRequest: vi.fn(async (method: string, params?: unknown): Promise<RpcResponse> => {
      const call: HostCall = { method, params: Object(params) }
      calls.push(call)
      inFlight += 1
      peakInFlight = Math.max(peakInFlight, inFlight)
      try {
        await new Promise((resolve) => setTimeout(resolve, 0))
        const result = answer(call)
        const body: unknown = Object(result).dataBase64
        wireBase64Bytes += typeof body === 'string' ? body.length : 0
        return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
      } finally {
        inFlight -= 1
      }
    }),
    subscribe: vi.fn(() => () => {}),
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    onStateChange: () => () => {},
    notifyForeground: vi.fn(),
    close: vi.fn()
  }
  return {
    client,
    calls,
    wireBase64Bytes: () => wireBase64Bytes,
    peakInFlight: () => peakInFlight
  }
}

/** One asset larger than a range, so the range grid pages it more than once. */
const FILES = {
  'assets/app.js': scriptBytes(MOBILE_WEB_BUNDLE_RANGE_BYTES * 2 + 5000, 1),
  'assets/vendor.js': scriptBytes(120_000, 2),
  'index.html': scriptBytes(600, 3)
}

function readsOf(calls: readonly HostCall[], method: string): HostCall[] {
  return calls.filter((call) => call.method === method)
}

async function fetchWith(readMethod: MobileWebBundleReadMethod, files = FILES) {
  const host = rangeHost(files)
  const fetched = await fetchMobileWebBundle({ client: host.client, readMethod })
  return { host, fetched }
}

async function refusalOf(failed: Promise<unknown>): Promise<string | null> {
  const error = await failed.then(
    () => null,
    (thrown: unknown) => thrown
  )
  return error instanceof MobileWebBundleFetchError ? error.refusal : null
}

describe('fetchMobileWebBundle over ranges', () => {
  it('pages every asset in ranges on the range grid and returns the verified bytes', async () => {
    const { host, fetched } = await fetchWith('range')

    for (const [path, content] of Object.entries(FILES)) {
      expect(fetched.assets.get(path)).toEqual(content)
    }
    expect(readsOf(host.calls, 'mobileWeb.bundle.chunk')).toHaveLength(0)
    const ranges = readsOf(host.calls, 'mobileWeb.bundle.range')
    // 3 for the large asset, 1 each for the other two.
    expect(ranges).toHaveLength(5)
    for (const range of ranges) {
      expect(range.params.length).toBe(MOBILE_WEB_BUNDLE_RANGE_BYTES)
      expect(Number(range.params.offset) % MOBILE_WEB_BUNDLE_RANGE_BYTES).toBe(0)
    }
    expect(host.peakInFlight()).toBeLessThanOrEqual(4)
  })

  // The discovery is the status capability the session already read, never a request of its own.
  it('sends nothing but the manifest and the reads to decide the method', async () => {
    const { host } = await fetchWith('range')

    expect(
      host.calls.filter(
        (call) =>
          call.method !== 'mobileWeb.bundle.range' && call.method !== 'mobileWeb.bundle.manifest'
      )
    ).toEqual([])
  })

  it('pages a host without the range capability in chunks, as before', async () => {
    const { host, fetched } = await fetchWith('chunk')

    expect(fetched.assets.get('assets/app.js')).toEqual(FILES['assets/app.js'])
    expect(readsOf(host.calls, 'mobileWeb.bundle.range')).toHaveLength(0)
    expect(readsOf(host.calls, 'mobileWeb.bundle.chunk').length).toBeGreaterThan(5)
  })

  it('carries the same bundle in fewer round trips and fewer bytes than chunks', async () => {
    const chunked = await fetchWith('chunk')
    const ranged = await fetchWith('range')

    // 17 + 3 + 1 chunks at 48 KiB against 3 + 1 + 1 ranges at 384 KiB.
    expect(readsOf(chunked.host.calls, 'mobileWeb.bundle.chunk')).toHaveLength(21)
    expect(readsOf(ranged.host.calls, 'mobileWeb.bundle.range')).toHaveLength(5)
    expect(ranged.host.wireBase64Bytes()).toBeLessThan(chunked.host.wireBase64Bytes() / 2)
  })

  it('refuses a corrupt gzip range as undecodable', async () => {
    const host = rangeHost(FILES, {
      tamper: (call, body) =>
        call.params.path === 'assets/app.js' && call.params.offset === 0
          ? encodeBase64(Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3))
          : body
    })

    expect(
      await refusalOf(fetchMobileWebBundle({ client: host.client, readMethod: 'range' }))
    ).toBe('range-undecodable')
  })

  it('refuses a range that decodes to the wrong length', async () => {
    const host = rangeHost(FILES, {
      tamper: (call, body) =>
        call.params.path === 'index.html'
          ? encodeBase64(gzipSync(scriptBytes(599, 3), { level: 6 }))
          : body
    })

    expect(
      await refusalOf(fetchMobileWebBundle({ client: host.client, readMethod: 'range' }))
    ).toBe('range-length-mismatch')
  })
})
