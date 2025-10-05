import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY; // Changed from SUPABASE_SERVICE_KEY to SUPABASE_ANON_KEY
const supabase = createClient(supabaseUrl, supabaseKey);

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const googleOAuthClient =
  googleClientId && googleClientSecret
    ? new OAuth2Client(googleClientId, googleClientSecret, 'postmessage')
    : null;

// Helper function to generate JWT token
const generateToken = (userId) => {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  );
};

export const createUser = async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // Validate input
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Please provide all required fields' });
    }

    // Check if user with email or username already exists
    const { data: existingUsers, error: userError } = await supabase
      .from('users')
      .select('*')
      .or(`email.eq.${email},username.eq.${username}`);

    if (userError) {
      console.error('Error checking existing users:', userError);
      return res.status(500).json({ error: 'Error checking user existence' });
    }

    if (existingUsers && existingUsers.length > 0) {
      const existingUser = existingUsers.find(user => user.email === email);
      return res.status(200).json({ 
        success: true,
        message: 'User already exists',
        user: {
          id: existingUser.id,
          email: existingUser.email,
          username: existingUser.username
        }
      });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create new user
    const { data: newUser, error: createError } = await supabase
      .from('users')
      .insert({
        username, 
        email, 
        password_hash: hashedPassword
      })
      .select()
      .single();

    if (createError) {
      console.error('Error creating user:', createError);
      return res.status(500).json({ error: 'Failed to create user' });
    }

    // Generate JWT token
    const token = generateToken(newUser.id);

    // Remove password hash from response
    const { password_hash, ...userWithoutPassword } = newUser;

    res.status(201).json({
      status: 'success',
      token,
      data: {
        user: userWithoutPassword
      }
    });

  } catch (error) {
    console.error('Error in createUser:', error);
    res.status(500).json({ 
      status: 'error',
      message: 'Internal server error' 
    });
  }
};

export const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({ 
        status: 'error',
        message: 'Please provide email and password' 
      });
    }

    // Find user by email
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (userError || !user) {
      return res.status(401).json({ 
        status: 'error',
        message: 'Invalid credentials' 
      });
    }

    // Check password
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ 
        status: 'error',
        message: 'Invalid credentials' 
      });
    }

    // Generate JWT token
    const token = generateToken(user.id);

    // Remove password hash from response
    const { password_hash, ...userWithoutPassword } = user;

    res.status(200).json({
      status: 'success',
      token,
      data: {
        user: userWithoutPassword
      }
    });

  } catch (error) {
    console.error('Error in loginUser:', error);
    res.status(500).json({ 
      status: 'error',
      message: 'Internal server error' 
    });
  }
};

export const googleAuth = async (req, res) => {
  try {
    if (!googleOAuthClient) {
      return res.status(500).json({
        status: 'error',
        message: 'Google authentication is not configured',
      });
    }

    const { code } = req.body;

    if (!code) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing Google authorization code',
      });
    }

    const { tokens } = await googleOAuthClient.getToken(code);

    if (!tokens?.id_token) {
      return res.status(400).json({
        status: 'error',
        message: 'Unable to retrieve Google ID token',
      });
    }

    googleOAuthClient.setCredentials(tokens);

    const ticket = await googleOAuthClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: googleClientId,
    });

    const payload = ticket.getPayload();

    if (!payload || !payload.email) {
      return res.status(400).json({
        status: 'error',
        message: 'Unable to verify Google credential',
      });
    }

    const email = payload.email;
    const displayName = payload.name?.trim() || email.split('@')[0];

    const { data: existingUser, error: existingUserError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (existingUserError && existingUserError.code !== 'PGRST116') {
      console.error('Error fetching user during Google auth:', existingUserError);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to process Google login',
      });
    }

    let userRecord = existingUser;

    if (!userRecord) {
      const username = email.split('@')[0];
      const hashedPlaceholderPassword = await bcrypt.hash(payload.sub || email, 10);

      const { data: newUser, error: createError } = await supabase
        .from('users')
        .insert({
          username,
          email,
          password_hash: hashedPlaceholderPassword,
        })
        .select()
        .single();

      if (createError) {
        console.error('Error creating user during Google auth:', createError);
        return res.status(500).json({
          status: 'error',
          message: 'Failed to create user from Google account',
        });
      }

      userRecord = newUser;
    }

    const token = generateToken(userRecord.id);
    const { password_hash: _passwordHash, ...userWithoutPassword } = userRecord;

    res.status(200).json({
      status: 'success',
      token,
      data: {
        user: {
          ...userWithoutPassword,
          username: userWithoutPassword.username ?? displayName,
        },
      },
    });
  } catch (error) {
    console.error('Error in googleAuth:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error during Google authentication',
    });
  }
};
