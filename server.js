const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.usdz': 'model/vnd.usdz+zip',
    '.glb': 'model/gltf-binary',
    '.mjs': 'text/javascript'
};

http.createServer((req, res) => {
    let filePath = '.' + req.url;
    if (filePath === './') filePath = './index3d.html';

    const extname = String(path.extname(filePath)).toLowerCase();
    const contentType = MIME_TYPES[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            res.writeHead(404);
            res.end("File not found");
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            // IMPORTANT: Removed 'utf-8' so 3D models and images don't break
            res.end(content);
        }
    });
}).listen(PORT);

console.log(`Server running at http://127.0.0.1:${PORT}/`);