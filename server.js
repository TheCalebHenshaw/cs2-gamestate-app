const http = require('http');

http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const state = JSON.parse(body);
    console.log(state); // live game data!
    res.end();
  });
}).listen(3000);