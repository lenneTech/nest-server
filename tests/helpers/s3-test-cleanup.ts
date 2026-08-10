/**
 * Shared teardown for suites that create S3 buckets.
 *
 * Every such suite names its bucket per run (`…-${Date.now()}-p${pid}`) for
 * isolation, which means every run that does not remove its bucket LEAKS one.
 * The objects inside were always deleted, so the leak is invisible in a bucket
 * listing by size — it shows up only as an ever-growing list of empty buckets in
 * the shared dev container and in CI's store.
 *
 * A bucket cannot be deleted while it still holds objects, so the two steps
 * belong together — which is exactly why this lives in one place rather than
 * being re-implemented per suite.
 */
export async function dropS3Buckets(client: any, buckets: string[]): Promise<void> {
  if (!client) {
    return;
  }

  const { DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3');

  for (const bucket of new Set(buckets.filter(Boolean))) {
    try {
      let continuationToken: string | undefined;
      do {
        const listed = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }),
        );
        const keys = (listed.Contents ?? []).map((object: { Key?: string }) => ({ Key: object.Key as string }));
        if (keys.length) {
          await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
        }
        continuationToken = listed.NextContinuationToken;
      } while (continuationToken);

      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    } catch {
      // Store unreachable, or the bucket was never created. Teardown must never
      // fail a suite that otherwise passed.
    }
  }
}
