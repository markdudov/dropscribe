/// <reference types="vitest/globals" />
/**
 * `scripts/binaries.mjs` — reading a binary's real architecture out of its own
 * header.
 *
 * WHAT IS BEING GUARDED. `binaryArch` is the only thing in the project that
 * answers "will this file execute on that CPU". Every other check answers a
 * question a wrong-architecture binary passes: it exists, it is executable, and
 * `enginesReady()` reports it present. So when this function is wrong, it is
 * wrong in the direction of a build that ships and then fails on hardware
 * nobody on the project is holding.
 *
 * It was wrong. `readBinaryAt` handed it the first 256 bytes of the file, and
 * the PE branch bounds-checked the header offset against *that buffer* rather
 * than against the file. A PE's `e_lfanew` at 0x3c points past a DOS stub of
 * arbitrary size:
 *
 *     ffmpeg.exe, ffprobe.exe          0x080   — inside the window, read fine
 *     whisper.dll, parakeet-cli.exe    0x100   — past it
 *     whisper-cli.exe                  0x108   — past it
 *     ggml-cpu-*.dll                   0x118   — past it
 *
 * Every one of those files is `IMAGE_FILE_MACHINE_AMD64`. Fifteen of the
 * seventeen read back as `null`, the `afterPack` gate called them
 * "unrecognised", and the Windows leg of the release could not produce an
 * installer at all — the two binaries that happened to have a short stub were
 * the only reason the bug looked like a manifest problem rather than a reader
 * problem.
 *
 * The fix is to stop reading a fixed prefix. `readBinaryAt` already reads the
 * whole file to hash it, so the truncated read bought nothing and cost the
 * entire Windows target. These tests pin the offsets above, and the buffer that
 * genuinely is too short still has to answer `null` rather than read garbage.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { binaryArch, readBinaryAt } from '../../scripts/binaries.mjs';

/**
 * A PE file with its header at `peOffset`, which is the whole variable that
 * matters. Everything between the DOS stub and the header is zero padding — a
 * real stub carries the "This program cannot be run in DOS mode" message and
 * some code, and nothing reads it.
 */
function pe(peOffset: number, machine: number): Buffer {
  const buf = Buffer.alloc(peOffset + 24);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.writeUInt32LE(0x0000_4550, peOffset); // 'PE\0\0'
  buf.writeUInt16LE(machine, peOffset + 4);
  return buf;
}

function machO(cputype: number): Buffer {
  const buf = Buffer.alloc(32);
  buf.writeUInt32LE(0xfeed_facf, 0);
  buf.writeUInt32LE(cputype, 4);
  return buf;
}

describe('binaryArch', () => {
  it('reads a PE header that sits inside the first 256 bytes', () => {
    expect(binaryArch(pe(0x80, 0x8664))).toBe('x64');
    expect(binaryArch(pe(0x80, 0xaa64))).toBe('arm64');
  });

  it('reads Mach-O, both architectures', () => {
    expect(binaryArch(machO(0x0100_000c))).toBe('arm64');
    expect(binaryArch(machO(0x0100_0007))).toBe('x64');
  });

  /*
   * Answering null is the safe direction and has to stay reachable: a truncated
   * read must not be talked into interpreting whatever bytes follow as a
   * machine word. The gate turns null into a refusal, which is correct — what
   * was wrong before was reaching this branch for a whole, valid file.
   */
  it('answers null rather than guessing, when the header is genuinely not there', () => {
    expect(binaryArch(pe(0x100, 0x8664).subarray(0, 0x40))).toBeNull();
    expect(binaryArch(Buffer.alloc(0))).toBeNull();
    expect(binaryArch(Buffer.from('not an executable at all, just text'))).toBeNull();
    expect(binaryArch(pe(0x80, 0x01c0))).toBeNull(); // ARM 32-bit, not a target
  });

  it('answers null for a file that is not there', () => {
    expect(readBinaryAt('/nonexistent/dropscribe/whisper-cli.exe')).toBeNull();
  });
});

/*
 * The regression lives here rather than in the block above, and the distance
 * between the two is the bug: `binaryArch` was never wrong about a buffer it
 * was given. It was given 256 bytes of a file whose header starts at 280.
 *
 * A test that hands `binaryArch` a whole synthetic buffer passes both before
 * and after the fix and proves nothing. The measurement has to go through the
 * disk, because the truncation was in the reading.
 */
describe('readBinaryAt, on a file whose PE header sits past the first 256 bytes', () => {
  let dir: string;

  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'dropscribe-pe-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  /*
   * These three offsets are measured from the binaries the app actually ships,
   * not invented: 0x080 is ffmpeg.exe and ffprobe.exe — the two that read fine
   * and made the failure look like a manifest problem — 0x100 is the whisper.cpp
   * DLLs and parakeet-cli.exe, 0x108 is whisper-cli.exe, and 0x118 is every
   * ggml-cpu-*.dll. All seventeen are IMAGE_FILE_MACHINE_AMD64.
   */
  it.each([
    ['ffmpeg.exe, ffprobe.exe', 0x080],
    ['whisper.dll, parakeet-cli.exe', 0x100],
    ['whisper-cli.exe', 0x108],
    ['ggml-cpu-*.dll', 0x118],
  ])('reads x64 from a file laid out like %s (e_lfanew=%i)', (name, offset) => {
    const file = join(dir, `${offset.toString(16)}.bin`);
    writeFileSync(file, pe(offset, 0x8664));
    expect(readBinaryAt(file), name).toMatchObject({ arch: 'x64' });
  });
});
