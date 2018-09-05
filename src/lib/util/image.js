// https://en.wikipedia.org/wiki/List_of_file_signatures
const KNOWN_IMAGE_MAGIC_BYTES = [
  {
    bytes: [0xff, 0xd8, 0xff, 0xdb],
    mime: "image/jpeg",
  },
  {
    bytes: [
      0xff,
      0xd8,
      0xff,
      0xe0,
      0x00,
      0x10,
      0x4a,
      0x46,
      0x49,
      0x46,
      0x00,
      0x01,
    ],
    mime: "image/jpeg",
  },
  {
    bytes: [0xff, 0xd8, 0xff, 0xe1, -1, -1, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00],
    mime: "image/jpeg",
  },
  {
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    mime: "image/png",
  },
]

/**
 * Scan through our list of magic bytes, and returns the corresponding image MIME.
 *
 * @param {Buffer} buffer
 * @return {string}
 */
export function imageMimeForMagicBytes(buffer) {
  for (let { bytes, mime } of KNOWN_IMAGE_MAGIC_BYTES) {
    if (bytes.every((byte, index) => byte === -1 || buffer[index] === byte)) {
      return mime
    }
  }
  return null
}
