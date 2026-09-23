/** Negotiated, never inferred from the desktop version: a build can ship without a bundle.
 *  Zod-free and dependency-free so `protocol-version.ts` can name it without pulling a schema
 *  library into the phone's capability path. */
export const MOBILE_WEB_BUNDLE_CAPABILITY = 'mobileWeb.bundle.v1'

/** The host serves `mobileWeb.bundle.range`. Advertised only beside the bundle capability. */
export const MOBILE_WEB_BUNDLE_RANGE_CAPABILITY = 'mobileWeb.bundle.range.v1'
