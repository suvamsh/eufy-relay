/**
 * Keyless decoder for eufy `v2_eufysecurity:` event / thumbnail images.
 *
 * The v2 wire format is NOT end-to-end encrypted and needs NO key, cipher, or
 * E2E private key. It is *head-only obfuscation*: only a small JPEG prefix
 * (~280-430 bytes, length varies per image) is AES-GCM encrypted (SOI +
 * APP0/JFIF + the two DQT quantization tables + SOF dimensions + the first DHT
 * table). Everything from the standard baseline DC-chrominance Huffman table
 * marker (`FF C4 00 1F 01`) onward — the rest of the DHT, the SOS, the entire
 * entropy-coded scan and the EOI — is left as plaintext, standard baseline JPEG.
 *
 * So we reconstruct a viewable JPEG by splicing a freshly built *standard*
 * libjpeg header (correct width/height + chroma subsampling) onto the blob's
 * plaintext tail. The encrypted prefix only ever held the quantization tables
 * (=> a small quality/colour shift if we substitute standard q85 tables) and
 * the image dimensions (=> the only thing that must be pinned exactly).
 *
 * Wire format:  v2_eufysecurity:<SERIAL>:<10-digit-pkt>:<binary-ciphertext>
 *
 * Reverse-engineered 2026-06-04; verified on 136 live blobs across every camera
 * model / resolution under HomeBase 3. On 2026-06-10 the reconstruction was
 * cross-checked against the app's OWN decoded output (carved from the running
 * app's heap): the keyless splice matches it, and push thumbnails are 288x176
 * 4:2:0 (other sizes — 256x144, 640x360, 4:4:4 snapshots — also occur, so the
 * geometry is auto-detected rather than assumed; see decodeV2ImageAuto).
 */
export declare const V2_PREFIX = "v2_eufysecurity:";
export type ChromaSubsampling = "4:2:0" | "4:2:2" | "4:4:4";
/** Build the standard JPEG header for a given geometry by patching the template. */
export declare function buildJpegPrefix(width: number, height: number, subsampling?: ChromaSubsampling): Buffer;
/**
 * Reconstruct a viewable JPEG from a v2 blob at a *known* geometry.
 * Returns null if the input is not a v2 blob or has no plaintext tail.
 */
export declare function spliceV2Image(data: Buffer, width: number, height: number, subsampling?: ChromaSubsampling): Buffer | null;
/**
 * Decode a v2 blob WITHOUT knowing its dimensions, by brute-forcing the size
 * ladder and using `jpeg-js` (an optional, pure-JS, dynamically-imported
 * dependency) to find the geometry where the entropy-coded scan exactly fills
 * the frame (no premature-EOI fill) with the correct chroma subsampling.
 *
 * The fastest production path is to pass the dimensions from event metadata to
 * {@link spliceV2Image} directly and skip this brute-force entirely.
 *
 * @returns the reconstructed JPEG + detected geometry, or null if undetectable
 *          / `jpeg-js` is not installed.
 */
export declare function decodeV2ImageAuto(data: Buffer): Promise<{
    jpeg: Buffer;
    width: number;
    height: number;
    subsampling: ChromaSubsampling;
    /** true when even the best geometry still looks like colour garbage (atypical/corrupt blob). */
    lowConfidence: boolean;
} | null>;
