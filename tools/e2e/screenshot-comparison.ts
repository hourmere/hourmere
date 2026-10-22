import sharp from 'sharp'

/** Allow bounded Chrome rasterisation jitter: at most 64 pixels, each RGBA channel within 2. */
export async function screenshotsWithinTolerance(left: Buffer, right: Buffer): Promise<boolean> {
  const decode = (png: Buffer) =>
    sharp(png).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const [leftImage, rightImage] = await Promise.all([decode(left), decode(right)])
  if (
    leftImage.info.width !== rightImage.info.width ||
    leftImage.info.height !== rightImage.info.height
  )
    return false

  let differingPixels = 0
  for (let offset = 0; offset < leftImage.data.length; offset += 4) {
    let different = false
    for (let channel = 0; channel < 4; channel++) {
      const difference = Math.abs(
        leftImage.data.readUInt8(offset + channel) - rightImage.data.readUInt8(offset + channel),
      )
      if (difference > 2) return false
      if (difference !== 0) different = true
    }
    if (different && ++differingPixels > 64) return false
  }
  return true
}
