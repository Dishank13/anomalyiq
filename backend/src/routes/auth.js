const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const auth = require('../middleware/auth');
const logger = require('../lib/logger');
const { validateBody, registerSchema, loginSchema } = require('../middleware/validate');

const router = express.Router();

const TOKEN_TTL = '7d';

const signToken = (user) =>
  jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: TOKEN_TTL });

const publicUser = (user) => ({ id: user._id, name: user.name, email: user.email });

// Register
router.post('/register', validateBody(registerSchema), async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const user = await User.create({ name, email, password });
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (error) {
    // The unique index on email is the real guard against duplicates. A
    // findOne() check beforehand loses the race between two concurrent
    // signups; catching E11000 does not.
    if (error.code === 11000) {
      return res.status(409).json({ message: 'Email already in use' });
    }
    // Previously this returned error.message to the client, which leaked
    // driver and schema internals on any unexpected failure.
    logger.error({ err: error }, 'register failed');
    res.status(500).json({ message: 'Server error' });
  }
});

// Login
router.post('/login', validateBody(loginSchema), async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    // Same response either way, so the endpoint cannot be used to discover
    // which email addresses are registered.
    const isMatch = user ? await user.comparePassword(password) : false;
    if (!user || !isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (error) {
    logger.error({ err: error }, 'login failed');
    res.status(500).json({ message: 'Server error' });
  }
});

// Current user
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    logger.error({ err: error }, 'fetch current user failed');
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
