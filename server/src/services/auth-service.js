const bcrypt = require('bcryptjs');
const { UniqueConstraintError } = require('sequelize');
const jwt = require('jsonwebtoken');

const { User } = require('../db');
const { createHttpError } = require('../utils/http-error');
const { normalizeEmail, validateCredentials } = require('../utils/validators');

const { OAuth2Client } = require('google-auth-library');
const jwtSecret = process.env.JWT_SECRET;

const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID
);

const MAX_NAME_LENGTH = 120;

/*
 * NEW: name is required for direct signup (the `name` column itself
 * stays nullable at the DB level — see db.js — so this is purely an
 * application-level rule, same pattern as password.
 */
function validateName(rawName) {
  const name = String(rawName || '').trim();

  if (!name) {
    throw createHttpError(400, 'Name is required');
  }

  if (name.length > MAX_NAME_LENGTH) {
    throw createHttpError(400, `Name must be ${MAX_NAME_LENGTH} characters or fewer`);
  }

  return name;
}

async function signupUser(payload) {
  const { email, password } = validateCredentials(payload);
  const name = validateName(payload?.name);
  const normalizedEmail = normalizeEmail(email);

  const passwordHash = await bcrypt.hash(password, 12);

  let user;
  try {
    user = await User.create({
      email: normalizedEmail,
      passwordHash,
      name,
    });
  } catch (error) {
    if (error instanceof UniqueConstraintError) {
      throw createHttpError(409, 'Email is already registered');
    }

    throw error;
  }

  return {
    token: signToken(user.id),
    user: serializeUser(user),
  };
}

async function loginUser(payload) {
  const { email, password } = validateCredentials(payload);
  const normalizedEmail = normalizeEmail(email);

  const user = await User.findOne({
    where: { email: normalizedEmail },
  });

  if (!user) {
    throw createHttpError(401, 'Invalid email or password');
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);

  if (!passwordMatches) {
    throw createHttpError(401, 'Invalid email or password');
  }

  return {
    token: signToken(user.id),
    user: serializeUser(user),
  };
}

function signToken(userId) {
  return jwt.sign({ sub: String(userId) }, jwtSecret, { expiresIn: '7d' });
}

function serializeUser(user) {
  return {
    id: user.id,
    email: user.email,
    // NEW: name + avatarUrl travel with the auth response so the
    // frontend can render them immediately after login/signup,
    // without waiting on a separate /me call.
    name: user.name || null,
    avatarUrl: user.avatarUrl || null,
    created_at: user.created_at || user.createdAt,
  };
}

async function googleLogin(credential) {
  if (!credential) {
    throw createHttpError(400, 'Google credential is required');
  }

  const ticket = await googleClient.verifyIdToken({
    idToken: credential,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();

  const googleId = payload.sub;
  const email = payload.email;
  const emailVerified = payload.email_verified;
  // NEW: Google's id token payload already carries these — no extra
  // API call needed to get the display name / profile photo.
  const googleName = typeof payload.name === 'string' ? payload.name.trim() : '';
  const googlePicture = typeof payload.picture === 'string' ? payload.picture : null;

  if (!email || !emailVerified) {
    throw createHttpError(401, 'Google email is not verified');
  }

  const normalizedEmail = normalizeEmail(email);

  // Find existing account
  let user = await User.findOne({
    where: {
      email: normalizedEmail,
    },
  });

  // Create account if it doesn't exist
  if (!user) {
    // Google users don't provide a password.
    // Generate an unusable random password hash so the
    // existing database structure continues to work.
    const randomPassword = `${googleId}-${Date.now()}-${Math.random()}`;
    const passwordHash = await bcrypt.hash(randomPassword, 12);

    try {
      user = await User.create({
        email: normalizedEmail,
        passwordHash,
        name: googleName || normalizedEmail.split('@')[0],
        avatarUrl: googlePicture,
      });
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        user = await User.findOne({
          where: {
            email: normalizedEmail,
          },
        });
      } else {
        throw error;
      }
    }
  } else {
    // NEW: an account that previously signed up with email/password
    // (or an older Google login before this field existed) can be
    // missing name/avatarUrl — backfill from Google without
    // overwriting anything the user already has.
    const updates = {};

    if (!user.name && googleName) {
      updates.name = googleName;
    }

    if (!user.avatarUrl && googlePicture) {
      updates.avatarUrl = googlePicture;
    }

    if (Object.keys(updates).length > 0) {
      await user.update(updates);
    }
  }

  return {
    token: signToken(user.id),
    user: serializeUser(user),
  };
}

module.exports = {
  loginUser,
  signupUser,
  googleLogin,
};