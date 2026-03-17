require('dotenv').config();

const express = require('express');
const path    = require('path');
const { recoverStaleJobs } = require('./src/jobStore');
const routes  = require('./src/routes');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', routes);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  const c = process.env;
  console.log('');
  console.log(`  ⚡ Gemini Email Scraper → http://localhost:${PORT}`);
  console.log(`     CDP Port:    ${c.CDP_PORT || 9226}`);
  console.log(`     Windows:     ${c.GEMINI_PARALLEL_WINDOWS || 5}`);
  console.log(`     BounceBan:   ${c.BOUNCEBAN_API_KEY && c.BOUNCEBAN_API_KEY !== 'your_bounceban_api_key_here' ? '✓ configured' : '✗ not set'}`);

  // Recover any jobs stuck as "running" from previous crash
  recoverStaleJobs();

  console.log('');
});
