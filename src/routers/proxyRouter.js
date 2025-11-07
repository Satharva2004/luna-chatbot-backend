import express from "express";
import { handleChartsGenerate } from "../controllers/chartsController.js";
import { authenticate, requireAuth } from "../middleware/auth.js";
import { uploadArray } from "../middleware/upload.js";

const router = express.Router();

router.post("/charts", authenticate, requireAuth, uploadArray, handleChartsGenerate);

export default router;
