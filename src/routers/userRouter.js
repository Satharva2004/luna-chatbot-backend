import express from 'express';
import { createUser, loginUser, googleAuth } from '../controllers/userController.js';

const router = express.Router();

// User registration route
router.post('/register', createUser);

// User login route
router.post('/login', loginUser);

// Google authentication route
router.post('/google', googleAuth);

export default router;
