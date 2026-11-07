// Vercel runs this as a serverless function. vercel.json sends every /api/... request
// here, and the Express app inside handles the route. Vercel serves the game from dist/.
import { createApp } from '../server/app.js';

const { app } = await createApp();

export default app;
