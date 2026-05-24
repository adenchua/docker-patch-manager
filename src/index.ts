import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import imagesRouter from './routes/images.js';
import scanRouter from './routes/scan.js';
import { startScheduler } from './services/scheduler.js';
import { openApiSpec } from './openapi.js';

const app = express();
const port = process.env.PORT ?? 5432;
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:3000';

// 1. Security headers
app.use(helmet());

// 2. CORS
app.use(cors({
  origin: ALLOWED_ORIGIN,
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type'],
  credentials: false,
}));

// 3. Body parsing with size cap
app.use(express.json({ limit: '10kb' }));

// 4. Rate limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/scan', scanLimiter);

// 5. Routes
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
app.get('/health', (_req, res) => { res.send('OK'); });
app.use('/images', imagesRouter);
app.use('/scan', scanRouter);

// 6. Global error handler — must be last, must have 4 params
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  const status =
    err instanceof Error && 'status' in err && typeof (err as { status: unknown }).status === 'number'
      ? (err as { status: number }).status
      : 500;
  res.status(status).json({ error: 'Internal server error' });
});

// 7. Process-level safety nets
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  startScheduler();
});
