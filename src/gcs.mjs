import { Storage } from "@google-cloud/storage";
import path from "node:path";
import fs from "node:fs";

const PROJECT_ID = process.env.GCLOUD_PROJECT;
const BUCKET = process.env.GCS_BUCKET;

const storage = new Storage({ projectId: PROJECT_ID });

export async function ensureBucket() {
  const [exists] = await storage.bucket(BUCKET).exists();
  if (!exists) await storage.createBucket(BUCKET, { location: process.env.GCLOUD_LOCATION || "us-central1" });
}

export async function uploadLocalFileToGCS(localPath, { dstName } = {}) {
  if (!BUCKET) throw new Error("GCS_BUCKET is not set");
  await ensureBucket();

  const filename = dstName || path.basename(localPath);
  const bucket = storage.bucket(BUCKET);
  const file = bucket.file(filename);

  await bucket.upload(localPath, {
    destination: file,
    resumable: true,
    metadata: { contentType: "video/mp4" }
  });

  return `gs://${BUCKET}/${filename}`;
}