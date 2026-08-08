const http = require('http');
const fs = require('fs');
const path = require('path');

const boundary = '----KnowledgePilotBoundary';
const filePath = path.join(__dirname, 'sample-upload.txt');
const fileContent = fs.readFileSync(filePath, 'utf8');
const payload = [
  `--${boundary}\r\n`,
  'Content-Disposition: form-data; name="file"; filename="sample-upload.txt"\r\n',
  'Content-Type: text/plain\r\n',
  '\r\n',
  fileContent,
  `\r\n--${boundary}--\r\n`,
].join('');

const req = http.request({
  hostname: 'localhost',
  port: 8080,
  path: '/documents/upload',
  method: 'POST',
  headers: {
    Authorization: 'Bearer test-token',
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': Buffer.byteLength(payload),
  },
}, (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    console.log('status', res.statusCode);
    console.log(data);
  });
});

req.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

req.write(payload);
req.end();
