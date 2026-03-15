import { SignJWT, jwtVerify } from 'jose'
import { randomBytes } from 'node:crypto'
import type { AuthUser } from './types'

/** Default token expiry: 30 minutes. */
const DEFAULT_EXPIRY = '30m'

/**
 * JWT signing secret. In production this should come from config
 * (/etc/anas/config.yaml). For now, generate a random secret per
 * process — tokens won't survive restart until config loading is
 * implemented in Epic 10.
 */
let secret: Uint8Array | null = null

function getSecret(): Uint8Array {
  if (!secret) {
    const configured = process.env.ANAS_JWT_SECRET
    if (configured) {
      secret = new TextEncoder().encode(configured)
    } else {
      // Generate random secret — tokens won't survive restart
      secret = randomBytes(32)
    }
  }
  return secret
}

/** Issue a signed JWT for an authenticated user. */
export async function signToken(user: AuthUser, expiry?: string): Promise<string> {
  return new SignJWT({ uid: user.uid })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.name)
    .setIssuer('anas')
    .setIssuedAt()
    .setExpirationTime(expiry ?? DEFAULT_EXPIRY)
    .sign(getSecret())
}

/** Verify a JWT and extract the user. Returns null if invalid/expired. */
export async function verifyToken(token: string): Promise<AuthUser | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: 'anas',
    })

    if (!payload.sub || typeof payload.uid !== 'number') {
      return null
    }

    return {
      name: payload.sub,
      uid: payload.uid,
    }
  } catch {
    return null
  }
}
