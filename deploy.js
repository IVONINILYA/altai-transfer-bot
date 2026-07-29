const https = require('https');

const BOTHOST_TOKEN = process.env.BOTHOST_TOKEN || '';

/**
 * Handle POST /deploy — webhook endpoint for GitHub Actions deploy trigger.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function handleDeploy(req, res) {
  try {
    // Read Bearer token from Authorization header
    const authHeader = req.headers['authorization'] || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/);
    const token = match ? match[1] : '';

    if (!token || token !== BOTHOST_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: invalid token' }));
      return;
    }

    // Read request body
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });

    req.on('end', () => {
      try {
        const payload = body ? JSON.parse(body) : {};

        // In production: proxy to bothost deploy API
        // In dev/mock mode: return success
        const deployUrl = process.env.BOTHOST_DEPLOY_URL || '';

        if (deployUrl && deployUrl !== '') {
          proxyToBothost(deployUrl, token, payload, res);
        } else {
          // Mock success response for dev environment
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'success',
            message: 'Deploy triggered (mock mode)',
            ref: payload.ref || null,
          }));
        }
      } catch (err) {
        console.error('[Deploy] Error processing body:', err.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    });

    req.on('error', (err) => {
      console.error('[Deploy] Request error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    });

  } catch (err) {
    console.error('[Deploy] Error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

/**
 * Proxy deploy request to bothost API.
 */
function proxyToBothost(deployUrl, token, payload, res) {
  try {
    const url = new URL(deployUrl);
    const postData = JSON.stringify(payload);

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const proxyReq = https.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => {
        data += chunk;
      });
      proxyRes.on('end', () => {
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(data || JSON.stringify({ status: 'success' }));
      });
    });

    proxyReq.on('error', (err) => {
      console.error('[Deploy] Proxy error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Deploy proxy failed' }));
    });

    proxyReq.write(postData);
    proxyReq.end();

  } catch (err) {
    console.error('[Deploy] Proxy setup error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Deploy proxy failed' }));
  }
}

module.exports = {
  handleDeploy,
};
