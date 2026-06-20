import express from 'express';
import { createUser, loginUser, googleAuth, updateProfile } from '../controllers/userController.js';
import { authenticate, requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.post('/register', createUser);
router.post('/login', loginUser);
router.post('/google', googleAuth);
router.put('/profile', authenticate, requireAuth, updateProfile);

export default router;
