// CRAFT-FORK 2026-07-20: sharp worker for the compiled sidecar (FEATURE-024, 域 32).
//
// `bun build --compile` binaries cannot resolve node_modules at runtime: bare
// specifiers resolve against the virtual `/$bunfs/root/`, and even an absolute
// import fails on the imported module's own `require`. sharp is therefore
// unreachable in-process from the packaged sidecar even though its files ship
// beside it.
//
// This worker runs under the bundled *non-compiled* bun (`vendor/bun/bun`),
// where normal resolution applies. It is spawned per job and talks over files
// so binary payloads never touch stdio.
//
// Usage: bun sharp-worker.mjs <job.json>
//   job = { sharpEntry, op: 'metadata' | 'process', inputPath, outputPath,
//           format?, quality?, resize?: { width, height }, fit?,
//           autoOrient?, keepIccProfile? }
// Exit 0 on success. On failure: message on stderr, exit 1.
//
// CRAFT-FORK 2026-07-24: 域 44 — this file is the packaged half of the
// ImageProcessor contract. Any option or metadata field added to
// `runtime/platform.ts` MUST be mirrored here, or dev and release make
// different encode decisions on the same image.

import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

async function main() {
  const jobPath = process.argv[2]
  if (!jobPath) throw new Error('sharp-worker: missing job file argument')

  const job = JSON.parse(await readFile(jobPath, 'utf8'))
  if (!job?.sharpEntry) throw new Error('sharp-worker: job.sharpEntry is required')

  const imported = await import(pathToFileURL(job.sharpEntry).href)
  const sharp = imported.default ?? imported

  const input = await readFile(job.inputPath)

  if (job.op === 'metadata') {
    const meta = await sharp(input).metadata()
    const result = meta?.width && meta?.height
      ? {
          width: meta.width,
          height: meta.height,
          format: meta.format,
          space: meta.space,
          orientation: meta.orientation,
          hasAlpha: meta.hasAlpha,
          hasProfile: Boolean(meta.icc),
        }
      : null
    await writeFile(job.outputPath, JSON.stringify(result), 'utf8')
    return
  }

  if (job.op !== 'process') throw new Error(`sharp-worker: unknown op ${job.op}`)

  let pipeline = sharp(input)
  // Orientation is baked in before resize so job.resize means visual dims.
  if (job.autoOrient) pipeline = pipeline.autoOrient()
  if (job.resize) {
    pipeline = pipeline.resize(job.resize.width, job.resize.height, {
      fit: job.fit ?? 'inside',
    })
  }
  // Never withMetadata()/keepMetadata() — EXIF/GPS/XMP/IPTC stay stripped.
  if (job.keepIccProfile) pipeline = pipeline.keepIccProfile()
  if (job.format === 'jpeg') {
    pipeline = pipeline.jpeg({ quality: job.quality ?? 90 })
  } else if (job.format === 'webp') {
    pipeline = pipeline.webp({ quality: job.quality ?? 90 })
  } else {
    pipeline = pipeline.png()
  }
  await writeFile(job.outputPath, await pipeline.toBuffer())
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? String(error)}\n`)
  process.exit(1)
})
