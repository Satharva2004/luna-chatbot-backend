import { Router } from "express";
import { createFeedback, getFeedback } from "../controllers/feedbackController.js";

const router = Router();

router.post("/", createFeedback);
router.get("/", getFeedback);

export default router;
