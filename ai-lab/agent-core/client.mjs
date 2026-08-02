// One place that builds the Gemini client for all three auth modes:
//
//   GEMINI_AUTH=adc      → keyless. Vertex AI via Application Default
//                          Credentials — on GKE this is Workload Identity
//                          (the pod's service account), no API key anywhere.
//                          Needs GOOGLE_CLOUD_PROJECT (+ optional
//                          GOOGLE_CLOUD_LOCATION, default us-central1).
//   GEMINI_VERTEX=1      → Vertex AI express key from the Cloud console.
//   (default)            → AI Studio key (aistudio.google.com).

import { GoogleGenAI } from '@google/genai';

export function authMode() {
  if (process.env.GEMINI_AUTH === 'adc') return 'adc';
  return process.env.GEMINI_VERTEX === '1' ? 'vertex-key' : 'aistudio';
}

/** True when the current mode has what it needs to attempt a call. */
export function hasCredentials() {
  if (authMode() === 'adc') return Boolean(process.env.GOOGLE_CLOUD_PROJECT);
  return Boolean(process.env.GEMINI_API_KEY);
}

/** Throws with code NO_KEY when credentials are missing (callers map this to 503). */
export function makeGenAI() {
  const mode = authMode();
  if (!hasCredentials()) {
    const err = new Error(
      mode === 'adc'
        ? 'GOOGLE_CLOUD_PROJECT is not set (required for GEMINI_AUTH=adc)'
        : 'GEMINI_API_KEY is not set'
    );
    err.code = 'NO_KEY';
    throw err;
  }
  if (mode === 'adc') {
    return new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
    });
  }
  const apiKey = process.env.GEMINI_API_KEY;
  return mode === 'vertex-key'
    ? new GoogleGenAI({ vertexai: true, apiKey })
    : new GoogleGenAI({ apiKey });
}
