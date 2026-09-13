import admin from 'firebase-admin';
import { env } from '../config/env.js';
let initialized = false;
/**
 * Lazy-initialize the Firebase Admin SDK from `multiflix-1833c-firebase-adminsdk.json` in
 * the backend root. Returns `null` when the file is missing or incomplete —
 * callers should treat that as "push is disabled" and silently skip sending.
 */
export function getFirebaseAdmin() {
    if (initialized) {
        return admin.apps.length > 0 ? admin : null;
    }
    const creds = env.firebaseServiceAccount;
    initialized = true;
    if (!creds || !creds.project_id || !creds.client_email || !creds.private_key) {
        console.warn('[firebase] multiflix-1833c-firebase-adminsdk.json not found or incomplete in backend root — push notifications disabled.');
        return null;
    }
    try {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: creds.project_id,
                clientEmail: creds.client_email,
                privateKey: creds.private_key,
            }),
        });
        console.log('[firebase] Admin SDK initialized for project', creds.project_id);
        return admin;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        console.error('[firebase] Admin init failed:', msg);
        return null;
    }
}
