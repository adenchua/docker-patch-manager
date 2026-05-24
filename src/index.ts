import express from 'express';

const app = express();
const port = process.env.PORT ?? 3000;

app.get('/', (_req, res) => {
  res.send('OK');
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
