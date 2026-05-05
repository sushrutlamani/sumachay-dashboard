const express = require('express');
const path    = require('path');
const app     = express();

app.get('/api/data', (req, res) => {
  res.sendFile(path.join(__dirname, 'data.json'));
});

app.use(express.static(path.join(__dirname)));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard on port ${PORT}`));
