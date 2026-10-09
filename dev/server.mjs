import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
http.createServer(async(req,res)=>{const url=new URL(req.url,'http://localhost');const target=path.resolve(root,'.'+(url.pathname==='/'?'/dev/preview.html':decodeURIComponent(url.pathname)));if(!target.startsWith(root+path.sep)){res.writeHead(403).end();return}try{const data=await readFile(target);res.setHeader('content-type',target.endsWith('.html')?'text/html; charset=utf-8':target.endsWith('.css')?'text/css':target.endsWith('.js')?'text/javascript':'application/octet-stream');res.end(data)}catch{res.writeHead(404).end()}}).listen(18765,'127.0.0.1',()=>console.log('WorldBook Opt preview http://127.0.0.1:18765'));
