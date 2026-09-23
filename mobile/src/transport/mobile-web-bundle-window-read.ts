import { MOBILE_WEB_BUNDLE_RANGE_BYTES } from '../../../src/shared/mobile-web-bundle/bundle-range-rpc-contract'
import { mobileWebBundleChunkRead, mobileWebBundleRangeRead } from './mobile-web-bundle-operations'
import { decodeMobileWebBundleRange } from './mobile-web-bundle-range-decode'
import type { MobileWebBundleReadMethod } from './mobile-web-bundle-read-method'
import type { RpcClient } from './rpc-client'
import { runRpcOperation } from './rpc-operation'

/** What either read method's reply restates about the window it answers. */
export type MobileWebBundleWindowReply = {
  readonly buildId: string
  readonly path: string
  readonly offset: number
  readonly assetByteLength: number
  readonly sha256: string
  readonly eof: boolean
  readonly dataBase64: string
  /** Present on a range reply only; a chunk's body is always raw. */
  readonly encoding?: string
}

/** The grid the fetch plans offsets on: the host's advertised chunk size, or the range ceiling. */
export function mobileWebBundleWindowBytes(
  method: MobileWebBundleReadMethod,
  chunkBytes: number
): number {
  return method === 'range' ? MOBILE_WEB_BUNDLE_RANGE_BYTES : chunkBytes
}

export async function requestMobileWebBundleWindow(
  client: RpcClient,
  method: MobileWebBundleReadMethod,
  window: { buildId: string; path: string; offset: number; length: number }
): Promise<MobileWebBundleWindowReply> {
  if (method === 'range') {
    return runRpcOperation(client, mobileWebBundleRangeRead, window)
  }
  return runRpcOperation(client, mobileWebBundleChunkRead, {
    buildId: window.buildId,
    path: window.path,
    offset: window.offset
  })
}

/**
 * The raw bytes of a window. A range is decoded to exactly `expectedLength` or refused; a chunk is
 * returned as sent, because its length checks against the chunk grid live with the fetch.
 */
export function decodeMobileWebBundleWindow(
  method: MobileWebBundleReadMethod,
  reply: MobileWebBundleWindowReply,
  expectedLength: number
): Uint8Array {
  const wire = decodeBase64(reply.dataBase64)
  if (method === 'chunk') {
    return wire
  }
  return decodeMobileWebBundleRange(
    { path: reply.path, offset: reply.offset, encoding: reply.encoding ?? '' },
    wire,
    expectedLength
  )
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
