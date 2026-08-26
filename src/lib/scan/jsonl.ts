import { open, type FileHandle } from "node:fs/promises";

/**
 * Incremental, resumable JSONL line reader.
 *
 * Claude Code transcripts are append-only and reach hundreds of megabytes. A
 * dashboard that re-parses the corpus on every sync is unusable, so scanning is
 * a tail-follow: persist a byte offset per file, and next time start there.
 *
 * The offset is only ever advanced past a *complete* line. A transcript being
 * written while we read it ends in a partial line; committing that offset would
 * skip the rest of the record forever. The scan therefore reports two numbers —
 * `committedOffset` (safe to persist) and `readOffset` (how far we actually
 * got) — and only the former should be stored.
 *
 * Approach adapted from steipete/CodexBar's `CostUsageJsonl`, which solves the
 * same problem in Swift for the same transcript format.
 */

/** 1 MiB. Measured against a real corpus: assistant lines carrying usage top out
 * around 45 KB, while multi-megabyte lines are tool results with no usage at
 * all. Skips are counted rather than swallowed so the margin stays observable. */
export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

const CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

/**
 * How much of an over-long line to retain purely to judge whether skipping it
 * mattered. A record's discriminating keys (`"type":"assistant"`) sit at the
 * front of the line, so a bounded head is enough to tell a harmless skip — a
 * multi-megabyte tool result — from a dropped usage record.
 */
const PREFILTER_HEAD_BYTES = 8 * 1024;

export interface ScanLine {
  /** Raw line bytes, newline excluded. */
  bytes: Buffer;
  /** Byte offset of the first byte of this line. */
  startOffset: number;
  /** Byte offset one past the line's terminating newline. */
  endOffset: number;
}

export interface ScanResult {
  /** Persist this. Never advances past an incomplete trailing line. */
  committedOffset: number;
  /** Where the read actually stopped, including any partial tail. */
  readOffset: number;
  linesRead: number;
  /** Lines that exceeded `maxLineBytes` and were skipped unparsed. */
  linesSkippedTooLong: number;
  /**
   * Of those, how many looked like they might have mattered — their opening
   * bytes matched the prefilter. Almost always zero: over-long lines are tool
   * results, not usage records. A non-zero value is the signal to raise
   * `maxLineBytes`, and is the difference between a metric you can act on and
   * a number that just counts noise.
   */
  linesSkippedPossiblyRelevant: number;
}

export interface ScanOptions {
  /** Byte offset to resume from. */
  offset?: number;
  maxLineBytes?: number;
  /**
   * Cheap byte-level prefilter applied before the caller sees a line. Lines
   * missing any of these substrings are discarded without allocating a string
   * or touching the JSON parser — on a 500 MB corpus this is the difference
   * between a scan and a stall, since only ~37% of lines carry usage at all.
   */
  requireAll?: readonly string[];
  signal?: AbortSignal;
}

/**
 * Read complete lines from `path` starting at `offset`, invoking `onLine` for
 * each that survives the prefilter.
 *
 * `onLine` receives a Buffer that is a **view into a reused chunk** — copy it if
 * you need it beyond the callback.
 */
export async function scanJsonl(
  path: string,
  onLine: (line: ScanLine) => void,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const startOffset = Math.max(0, options.offset ?? 0);
  const needles = (options.requireAll ?? []).map((s) => Buffer.from(s, "utf8"));

  let handle: FileHandle | undefined;
  const result: ScanResult = {
    committedOffset: startOffset,
    readOffset: startOffset,
    linesRead: 0,
    linesSkippedTooLong: 0,
    linesSkippedPossiblyRelevant: 0,
  };

  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();

    if (startOffset >= size) {
      // Nothing new. A file that *shrank* below the cursor was truncated or
      // replaced; the caller decides whether to reset, since we cannot tell
      // rotation from corruption from here.
      result.committedOffset = Math.min(startOffset, size);
      result.readOffset = result.committedOffset;
      return result;
    }

    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    // Carry holds the bytes of a line split across chunk boundaries.
    let carry: Buffer[] = [];
    let carryBytes = 0;
    let lineStart = startOffset;
    let position = startOffset;
    let lineOverflowed = false;
    // Retained across the overflow discard so a skip can be judged.
    let head: Buffer = Buffer.alloc(0);

    while (position < size) {
      if (options.signal?.aborted) throw new DOMException("Scan aborted", "AbortError");

      const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, position);
      if (bytesRead === 0) break;

      let cursor = 0;
      while (cursor < bytesRead) {
        const newlineAt = chunk.indexOf(NEWLINE, cursor);
        const hasNewline = newlineAt !== -1 && newlineAt < bytesRead;
        const sliceEnd = hasNewline ? newlineAt : bytesRead;
        const slice = chunk.subarray(cursor, sliceEnd);

        if (!hasNewline) {
          // Partial line: stash it and pull the next chunk.
          if (head.length < PREFILTER_HEAD_BYTES) {
            head = Buffer.concat([head, slice.subarray(0, PREFILTER_HEAD_BYTES - head.length)]);
          }
          if (carryBytes + slice.length > maxLineBytes) {
            // Stop accumulating a line we have already decided to skip, so a
            // 2 GB line cannot exhaust memory before we reach its newline.
            lineOverflowed = true;
            carry = [];
            carryBytes = 0;
          } else {
            carry.push(Buffer.from(slice));
            carryBytes += slice.length;
          }
          cursor = bytesRead;
          break;
        }

        const lineEnd = position + newlineAt + 1;
        const totalBytes = carryBytes + slice.length;

        if (lineOverflowed || totalBytes > maxLineBytes) {
          result.linesSkippedTooLong += 1;
          const judged = head.length > 0 ? head : slice.subarray(0, PREFILTER_HEAD_BYTES);
          if (needles.length === 0 || matchesAny(judged, needles)) {
            result.linesSkippedPossiblyRelevant += 1;
          }
        } else {
          const line =
            carry.length === 0 ? slice : Buffer.concat([...carry, Buffer.from(slice)], totalBytes);
          if (line.length > 0 && matchesAll(line, needles)) {
            result.linesRead += 1;
            onLine({ bytes: line, startOffset: lineStart, endOffset: lineEnd });
          }
        }

        // A complete line was consumed, so the offset is now safe to persist.
        result.committedOffset = lineEnd;
        carry = [];
        carryBytes = 0;
        lineOverflowed = false;
        head = Buffer.alloc(0);
        lineStart = lineEnd;
        cursor = newlineAt + 1;
      }

      position += bytesRead;
      result.readOffset = position;
    }

    result.readOffset = Math.min(position, size);
    return result;
  } finally {
    await handle?.close();
  }
}

function matchesAll(line: Buffer, needles: readonly Buffer[]): boolean {
  for (const needle of needles) {
    if (line.indexOf(needle) === -1) return false;
  }
  return true;
}

/**
 * Any-match, used only to judge a skipped line from its head.
 *
 * Deliberately looser than `matchesAll`: a usage record's trailing needle
 * (`"usage"`) sits past the retained head, so requiring all of them would call
 * every skip harmless. Over-reporting a possible loss is the safe direction.
 */
function matchesAny(head: Buffer, needles: readonly Buffer[]): boolean {
  for (const needle of needles) {
    if (head.indexOf(needle) !== -1) return true;
  }
  return false;
}
