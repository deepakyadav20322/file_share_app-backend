const { Readable } = require('stream');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const bucket = process.env.S3_BUCKET;
const prefix = process.env.S3_PREFIX || 'transfers/';

const PART_SIZE = 5 * 1024 * 1024; // S3's minimum part size
const PARALLEL_PARTS = 4; // parts in flight at once: much faster over a slow or distant link
const CHUNK = 32 * 1024;

const client = new S3Client({
  region: process.env.S3_REGION || 'us-east-1',
  // Optional: set S3_ENDPOINT for S3-compatible services (Cloudflare R2, MinIO...).
  ...(process.env.S3_ENDPOINT && { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }),
  // Falls back to the default AWS credential chain when these are not set.
  ...(process.env.AWS_ACCESS_KEY_ID && {
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  }),
  // Streamed parts have a known length, so no extra checksum trailer is needed.
  requestChecksumCalculation: 'WHEN_REQUIRED',
});

// A readable view of part of the buffer that reports every chunk as the HTTP layer pulls it, so the
// progress follows what is really being sent (within a small lead for socket buffers).
const countedStream = (buffer, onBytes) =>
  Readable.from(
    (function* () {
      for (let at = 0; at < buffer.length; at += CHUNK) {
        const chunk = buffer.subarray(at, Math.min(at + CHUNK, buffer.length));
        onBytes(chunk.length);
        yield chunk;
      }
    })(),
    { objectMode: false, highWaterMark: CHUNK }
  );

module.exports = {
  name: 's3',

  // onProgress(bytesDone) is optional. Small files go up in one request; larger ones in parallel parts.
  async save(storageKey, buffer, mimeType, onProgress) {
    const Key = prefix + storageKey;
    const ContentType = mimeType || 'application/octet-stream';

    if (buffer.length <= PART_SIZE) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key, Body: buffer, ContentType }));
      onProgress?.(buffer.length);
      return;
    }

    const { UploadId } = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key, ContentType }));
    const count = Math.ceil(buffer.length / PART_SIZE);
    const etags = new Array(count);
    let sent = 0;
    let next = 0;

    const worker = async () => {
      while (next < count) {
        const index = next++;
        const part = buffer.subarray(index * PART_SIZE, Math.min((index + 1) * PART_SIZE, buffer.length));
        const { ETag } = await client.send(
          new UploadPartCommand({
            Bucket: bucket,
            Key,
            UploadId,
            PartNumber: index + 1,
            ContentLength: part.length,
            Body: countedStream(part, (n) => {
              sent += n;
              onProgress?.(sent);
            }),
          })
        );
        etags[index] = ETag;
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, count) }, worker));
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key,
          UploadId,
          MultipartUpload: { Parts: etags.map((ETag, i) => ({ ETag, PartNumber: i + 1 })) },
        })
      );
    } catch (e) {
      await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key, UploadId })).catch(() => {});
      throw e;
    }
    onProgress?.(buffer.length);
  },

  // Short-lived signed link to download one file straight from S3. It always saves as a file with its real
  // name (never opens in the browser) and is not cached. Valid only for `expiresIn` seconds to START a download.
  async downloadUrl(storageKey, fileName, mimeType, expiresIn) {
    const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    const utf8 = encodeURIComponent(fileName).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: prefix + storageKey,
        ResponseContentDisposition: `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`,
        ResponseContentType: mimeType || 'application/octet-stream',
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn }
    );
  },

  async read(storageKey) {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: prefix + storageKey }));
    return res.Body;
  },

  // ---- Direct upload: the browser sends the bytes straight to S3 with signed part links ----------------
  partSize: PART_SIZE,

  // Starts a multipart upload and returns signed PUT links, one per 5 MB part (the last part may be smaller).
  // Each link is valid for `expiresIn` seconds and only for its own part of this one upload.
  async startDirect(storageKey, size, mimeType, expiresIn) {
    const Key = prefix + storageKey;
    const { UploadId } = await client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key, ContentType: mimeType || 'application/octet-stream' })
    );
    const count = Math.max(1, Math.ceil(size / PART_SIZE));
    const parts = [];
    for (let n = 1; n <= count; n++) {
      const url = await getSignedUrl(client, new UploadPartCommand({ Bucket: bucket, Key, UploadId, PartNumber: n }), { expiresIn });
      parts.push({ partNumber: n, size: Math.min(PART_SIZE, size - (n - 1) * PART_SIZE), url });
    }
    return { uploadId: UploadId, parts };
  },

  // Joins the parts once every part S3 received has exactly the expected size; anything else is
  // thrown away. Returns the final object size from S3 (checked again before the transfer is created).
  async finishDirect(storageKey, uploadId, expectedSizes) {
    const Key = prefix + storageKey;
    const listed = await client.send(new ListPartsCommand({ Bucket: bucket, Key, UploadId: uploadId, MaxParts: 1000 }));
    const got = (listed.Parts || []).slice().sort((a, b) => a.PartNumber - b.PartNumber);
    const ok =
      got.length === expectedSizes.length && got.every((p, i) => p.PartNumber === i + 1 && p.Size === expectedSizes[i]);
    if (!ok) {
      await this.abortDirect(storageKey, uploadId);
      const e = new Error('Uploaded parts do not match the declared file.');
      e.code = 'PART_MISMATCH';
      throw e;
    }
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key,
        UploadId: uploadId,
        MultipartUpload: { Parts: got.map((p) => ({ ETag: p.ETag, PartNumber: p.PartNumber })) },
      })
    );
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key }));
    return head.ContentLength;
  },

  async abortDirect(storageKey, uploadId) {
    await client
      .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: prefix + storageKey, UploadId: uploadId }))
      .catch(() => {});
  },

  async remove(storageKey) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: prefix + storageKey })).catch(() => {});
  },
};
