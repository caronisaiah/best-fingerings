// src/api.ts

import type { ResultPayload } from "./types";

export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "/api";

/**
 * Backend can return:
 * - QUEUED with job_id
 * - SUCCEEDED from cache with job_id null (or a real job_id if you implement "virtual jobs" later)
 */
export type FingeringsQueued = {
  status: "QUEUED";
  job_id: string;
  score_hash: string;
  config_hash: string;
  cached: false;
  versions?: Record<string, unknown>;
  preferences?: Record<string, unknown>;
};

export type FingeringsSucceeded = {
  status: "SUCCEEDED";
  job_id: string | null; // null on cache hit unless you implement virtual-job records
  score_hash: string;
  config_hash: string;
  result_s3_key: string;
  result_url?: string | null;
  cached: true;
  versions?: Record<string, unknown>;
  preferences?: Record<string, unknown>;
};

export type FingeringsResponse = FingeringsQueued | FingeringsSucceeded;

export type JobStatus = {
  job_id: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  score_hash?: string | null;
  config_hash?: string | null;
  input_s3_key?: string | null;
  result_s3_key?: string | null;
  result_url?: string | null;
  error?: string | null;
  parse_ms?: string | null;
  optimize_ms?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  retry_after_ms?: number | null;
};

async function mustJson(r: Response) {
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function postFingerings(args: {
  file: File;
  difficulty?: string;
  style_bias?: string;
  hand_size?: string;
  articulation_bias?: string;
  locked_note_fingerings?: Record<string, number>;
  force_recompute?: boolean;
  presign_expires_seconds?: number;
}): Promise<FingeringsResponse> {
  const {
    file,
    difficulty = "standard",
    style_bias = "neutral",
    hand_size = "medium",
    articulation_bias = "auto",
    locked_note_fingerings = {},
    force_recompute = false,
    presign_expires_seconds = 3600,
  } = args;

  const fd = new FormData();
  fd.append("file", file);
  fd.append("difficulty", difficulty);
  fd.append("style_bias", style_bias);
  fd.append("hand_size", hand_size);
  fd.append("articulation_bias", articulation_bias);
  fd.append("locked_note_fingerings_json", JSON.stringify(locked_note_fingerings));
  fd.append("force_recompute", String(force_recompute));
  fd.append("presign_expires_seconds", String(presign_expires_seconds));

  const r = await fetch(`${API_BASE}/fingerings`, {
    method: "POST",
    body: fd,
  });

  return (await mustJson(r)) as FingeringsResponse;
}

export async function getJob(jobId: string): Promise<JobStatus> {
  const r = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}`);
  return (await mustJson(r)) as JobStatus;
}

/** Result payload stored by backend in S3 and served via /results/{job_id} */
export async function getResult(jobId: string): Promise<ResultPayload> {
  const r = await fetch(`${API_BASE}/results/${encodeURIComponent(jobId)}`);
  return (await mustJson(r)) as ResultPayload;
}

/** Cache-hit fallback: fetch JSON directly from presigned S3 URL */
export async function getResultFromPresigned(url: string): Promise<ResultPayload> {
  const r = await fetch(url);
  return (await mustJson(r)) as ResultPayload;
}

export async function getResultByKey(resultKey: string): Promise<ResultPayload> {
  const qs = new URLSearchParams({ key: resultKey });
  const r = await fetch(`${API_BASE}/results/by-key?${qs.toString()}`);
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()) as ResultPayload;
}
