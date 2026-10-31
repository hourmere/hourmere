// Public pages may use an existing first-party raster asset. Provider profile pictures
// can disclose invitee visits, and image URLs must never carry email or query data.
const PUBLIC_AVATAR_IMAGE =
  /^\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(?:avif|gif|jpe?g|png|webp)(?![\s\S])/i

/** An existing root-relative raster image, without URL escapes, parameters or fragments. */
export function publicAvatarImage(value: unknown): string | undefined {
  return typeof value === 'string' && PUBLIC_AVATAR_IMAGE.test(value) ? value : undefined
}
