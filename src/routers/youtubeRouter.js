import express from 'express';
import {
  listResources,
  executeResource,
  healthCheck,
  youtubeSearch
} from '../controllers/youtubeController.js';

const router = express.Router();

router.get('/resources', listResources);
router.post('/execute', executeResource);

// Health check for MCP services
router.get('/health', healthCheck);

// Convenience endpoints for direct YouTube access
router.post('/youtube/search', youtubeSearch);

export default router;
