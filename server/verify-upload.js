const fs = require('fs');
const path = require('path');
const http = require('http');

function requestJson(method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 8080,
      path: pathname,
      method,
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body || '') },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.write(body || '');
    req.end();
  });
}

async function main() {
  const email = `phase2-${Date.now()}@example.com`;
  const signupResponse = await requestJson('POST', '/auth/signup', JSON.stringify({ email, password: 'password123' }));
  const signup = JSON.parse(signupResponse.body);
  console.log('signup-status', signupResponse.status);
  console.log('token-issued', Boolean(signup.token));

  const boundary = '----KnowledgePilotBoundary';
  const filePath = path.join(process.cwd(), 'sample-upload.txt');
  fs.writeFileSync(filePath, 'This is a sample document for the Phase 2 ingestion pipeline. It contains enough text to be chunked and stored by the backend. Another paragraph helps ensure the content is split into multiple chunks.');
  const fileContent = fs.readFileSync(filePath, 'utf8');

  const payload = [
    `--${boundary}\r\n`,
    'Content-Disposition: form-data; name="file"; filename="sample-upload.txt"\r\n',
    'Content-Type: text/plain\r\n',
    '\r\n',
    fileContent,
    `\r\n--${boundary}--\r\n`,
  ].join('');

  const uploadResponse = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 8080,
      path: '/documents/upload',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signup.token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });

  console.log('upload-status', uploadResponse.status);
  console.log(uploadResponse.body);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
