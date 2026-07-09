import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { connectDb } from './db.js';
import { warnIfAdminKeyMissing } from './middleware/requireAdminKey.js';
import ingestRoutes from './routes/ingest.js';
import repoRoutes from './routes/repos.js';

const PORT = Number(process.env.PORT ?? 4000);
const MONGODB_URI = process.env.MONGODB_URI;
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:5173';

if (!MONGODB_URI) {
  console.error('MONGODB_URI is required in server/.env');
  process.exit(1);
}

warnIfAdminKeyMissing();

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '10mb' }));

app.get('/api/v1/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/v1/ingest', ingestRoutes);
app.use('/api/v1/repos', repoRoutes);

async function main() {
  await connectDb(MONGODB_URI!);
  app.listen(PORT, () => {
    console.log(`codeRefiner analytics server on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
