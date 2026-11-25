'use strict';

const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;

/**
 * Check that an uploaded snap is a real JPEG, PNG or WebP image (by its
 * magic bytes, not by anything the client claims) and not too big.
 * Returns the MIME type, or null if the upload should be rejected.
 */
function detectImageType(data) {
  let buf = data;
  if (buf instanceof ArrayBuffer) buf = Buffer.from(buf);
  else if (ArrayBuffer.isView(buf) && !Buffer.isBuffer(buf)) buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.length > MAX_IMAGE_BYTES) return null;

  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

module.exports = { detectImageType, toBuffer, MAX_IMAGE_BYTES };
