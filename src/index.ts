import express from 'express';
import swaggerUi from 'swagger-ui-express';
import imagesRouter from './routes/images.js';
import scanRouter from './routes/scan.js';
import { startScheduler } from './services/scheduler.js';
import { openApiSpec } from './openapi.js';

const app = express();
const port = process.env.PORT ?? 5432;

app.use(express.json());
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

app.get('/health', (_req, res) => {
  res.send('OK');
});

app.use('/images', imagesRouter);
app.use('/scan', scanRouter);

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  startScheduler();
});
