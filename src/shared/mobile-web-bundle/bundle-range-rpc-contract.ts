import { z } from 'zod'
import {
  MobileWebBundleAssetPathSchema,
  MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES
} from './manifest-contract'

/** 384 KiB raw is 512 KiB of base64, which the base64 mobile E2EE reply grows to ~683 KiB
 *  (393216 x 16/9 = 699051 bytes) plus the envelope: under the 1 MiB WebSocket and relay frame
 *  ceiling. Gzip never raises that bound, because the host sends identity when gzip does not shrink. */
export const MOBILE_WEB_BUNDLE_RANGE_BYTES = 384 * 1024

/** A method rather than a field on `mobileWeb.bundle.chunk`: released hosts parse chunk params
 *  strictly, so a `length` or an encoding request would be refused there, not ignored. */
export const MOBILE_WEB_BUNDLE_RANGE_METHOD = 'mobileWeb.bundle.range'

export const MOBILE_WEB_BUNDLE_RANGE_ENCODINGS = ['gzip', 'identity'] as const
export type MobileWebBundleRangeEncoding = (typeof MOBILE_WEB_BUNDLE_RANGE_ENCODINGS)[number]

const SHA256_PATTERN = /^[a-f0-9]{64}$/
export const MOBILE_WEB_BUNDLE_RANGE_MAX_DATA_BASE64_LENGTH =
  Math.ceil(MOBILE_WEB_BUNDLE_RANGE_BYTES / 3) * 4 + 8

/** `offset` must be a multiple of `length`, checked host-side: the grid is the caller's own. */
export const MobileWebBundleRangeParamsSchema = z
  .object({
    buildId: z.string().regex(SHA256_PATTERN),
    path: MobileWebBundleAssetPathSchema,
    offset: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES),
    length: z.number().int().positive().max(MOBILE_WEB_BUNDLE_RANGE_BYTES)
  })
  .strict()

/** Same self-description as a chunk. `dataBase64` is the range after `encoding`; its decoded
 *  length is `min(length, assetByteLength - offset)`, which the caller already knows. */
export const MobileWebBundleRangeResultSchema = z
  .object({
    buildId: z.string().regex(SHA256_PATTERN),
    path: MobileWebBundleAssetPathSchema,
    offset: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES),
    assetByteLength: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES),
    sha256: z.string().regex(SHA256_PATTERN),
    encoding: z.enum(MOBILE_WEB_BUNDLE_RANGE_ENCODINGS),
    dataBase64: z.string().max(MOBILE_WEB_BUNDLE_RANGE_MAX_DATA_BASE64_LENGTH),
    eof: z.boolean()
  })
  .strict()

export type MobileWebBundleRangeParams = z.infer<typeof MobileWebBundleRangeParamsSchema>
export type MobileWebBundleRangeResult = z.infer<typeof MobileWebBundleRangeResultSchema>
