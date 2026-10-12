/**
 * Normalize a buffer of ADTS audio data by scanning for ADTS frames and splitting
 * any multi-RDB frames into individual single-RDB frames.
 *
 * The input buffer may contain one or more concatenated ADTS frames.  Non-ADTS
 * data (or data without a valid sync word) is returned unchanged in a
 * single-element array.
 *
 * For the common case of a single-RDB frame, no allocation occurs — the original
 * buffer region is returned via subarray.
 */
export declare function normalizeAdtsFrames(data: Buffer): Buffer[];
