import { Router } from "express";
import { ingestReservationHandler } from "../controllers/ingest.controller";

const router = Router();

router.post("/reservations", ingestReservationHandler);

export default router;
