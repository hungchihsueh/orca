import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BUNDLE_RANGE_BYTES,
  MOBILE_WEB_BUNDLE_RANGE_MAX_DATA_BASE64_LENGTH,
  MOBILE_WEB_BUNDLE_RANGE_METHOD,
  MobileWebBundleRangeParamsSchema,
  MobileWebBundleRangeResultSchema
} from './bundle-range-rpc-contract'
import { MOBILE_WEB_BUNDLE_RANGE_CAPABILITY } from './mobile-web-bundle-capability'

/** Both transports refuse a frame over 1 MiB. */
const FRAME_CEILING_BYTES = 1024 * 1024
/** base64 body inside the base64 mobile E2EE reply. */
const E2EE_EXPANSION = 16 / 9
/** Envelope, ids and every other result member, generously. */
const REPLY_OVERHEAD_BYTES = 4096

const PARAMS = { buildId: 'a'.repeat(64), path: 'assets/a.js', offset: 0, length: 4096 }
const RESULT = {
  buildId: 'a'.repeat(64),
  path: 'assets/a.js',
  offset: 0,
  assetByteLength: 4096,
  sha256: 'b'.repeat(64),
  encoding: 'gzip',
  dataBase64: 'AAAA',
  eof: true
}

describe('mobileWeb.bundle.range contract', () => {
  it('pins the wire names and the range size', () => {
    expect(MOBILE_WEB_BUNDLE_RANGE_METHOD).toBe('mobileWeb.bundle.range')
    expect(MOBILE_WEB_BUNDLE_RANGE_CAPABILITY).toBe('mobileWeb.bundle.range.v1')
    expect(MOBILE_WEB_BUNDLE_RANGE_BYTES).toBe(393216)
  })

  it('fits a full identity range under the frame ceiling after E2EE expansion', () => {
    const wire =
      (MOBILE_WEB_BUNDLE_RANGE_MAX_DATA_BASE64_LENGTH + REPLY_OVERHEAD_BYTES) *
      (E2EE_EXPANSION / (4 / 3))
    expect(wire).toBeLessThan(FRAME_CEILING_BYTES)
  })

  it('round-trips params and result', () => {
    expect(MobileWebBundleRangeParamsSchema.parse(PARAMS)).toEqual(PARAMS)
    expect(MobileWebBundleRangeResultSchema.parse(RESULT)).toEqual(RESULT)
    expect(
      MobileWebBundleRangeResultSchema.parse({ ...RESULT, encoding: 'identity' }).encoding
    ).toBe('identity')
  })

  it('caps the requested length and refuses an empty one', () => {
    expect(
      MobileWebBundleRangeParamsSchema.safeParse({
        ...PARAMS,
        length: MOBILE_WEB_BUNDLE_RANGE_BYTES
      }).success
    ).toBe(true)
    for (const length of [MOBILE_WEB_BUNDLE_RANGE_BYTES + 1, 0, -1, 1.5]) {
      expect(MobileWebBundleRangeParamsSchema.safeParse({ ...PARAMS, length }).success).toBe(false)
    }
  })

  it('is strict on both sides and closed on the encoding', () => {
    expect(MobileWebBundleRangeParamsSchema.safeParse({ ...PARAMS, encoding: 'br' }).success).toBe(
      false
    )
    expect(MobileWebBundleRangeResultSchema.safeParse({ ...RESULT, extra: 1 }).success).toBe(false)
    expect(MobileWebBundleRangeResultSchema.safeParse({ ...RESULT, encoding: 'br' }).success).toBe(
      false
    )
    expect(
      MobileWebBundleRangeResultSchema.safeParse({
        ...RESULT,
        dataBase64: 'A'.repeat(MOBILE_WEB_BUNDLE_RANGE_MAX_DATA_BASE64_LENGTH + 1)
      }).success
    ).toBe(false)
  })
})
