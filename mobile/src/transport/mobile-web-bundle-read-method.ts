import { MOBILE_WEB_BUNDLE_RANGE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'

/** `range` pages 384 KiB gzipped windows; `chunk` pages the 48 KiB raw ones every bundle host serves. */
export type MobileWebBundleReadMethod = 'range' | 'chunk'

/**
 * Read off the `status.get` capabilities this connection already proved, never probed: a phone
 * calling a method an older desktop never allowlisted is told `forbidden`, not `method_not_found`,
 * so a probe would need to read an authorization code as absence. A host without the capability
 * keeps being paged in chunks, which is what it has always served.
 */
export function mobileWebBundleReadMethodFor(
  hostCapabilities: readonly string[]
): MobileWebBundleReadMethod {
  return hostCapabilities.includes(MOBILE_WEB_BUNDLE_RANGE_CAPABILITY) ? 'range' : 'chunk'
}
