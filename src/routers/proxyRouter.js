import express from "express";
import { handleChartsGenerate } from "../controllers/chartsController.js";
import { handleChatGenerate } from "../controllers/chatController.js";
import { authenticate, requireAuth } from "../middleware/auth.js";
import { uploadArray } from "../middleware/upload.js";

const router = express.Router();

// Charts generation endpoint
router.post("/charts", authenticate, requireAuth, uploadArray, handleChartsGenerate);

// Chat endpoint with Excalidraw function calling support
router.post("/chat", authenticate, requireAuth, uploadArray, handleChatGenerate);

export default router;
