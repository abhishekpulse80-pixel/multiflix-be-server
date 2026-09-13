import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env.js';
import { HttpError } from './httpError.js';

const client = new OAuth2Client();

export type GoogleIdTokenPayload = {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
};

export async function verifyGoogleIdToken(
  idToken: string,
): Promise<GoogleIdTokenPayload> {
  const audiences = env.googleSignInClientIds;
  if (audiences.length === 0) {
    throw new HttpError(
      503,
      'Google Sign-In is not configured on this server',
      'GOOGLE_NOT_CONFIGURED',
    );
  }
  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: audiences,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub) {
      throw new HttpError(401, 'Invalid Google token', 'INVALID_GOOGLE_TOKEN');
    }
    return {
      sub: payload.sub,
      email: payload.email ?? undefined,
      email_verified: payload.email_verified,
      name: payload.name ?? undefined,
      picture: payload.picture ?? undefined,
    };
  } catch (err: unknown) {
    if (err instanceof HttpError) {
      throw err;
    }
    throw new HttpError(401, 'Invalid Google token', 'INVALID_GOOGLE_TOKEN');
  }
}

